// =============================================================================
// GENHUB - Pay-to-Chat Messages API Route
// POST /api/messages - Send a paid message
// GET /api/messages - Get messages for a conversation
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { debitWallet, splitRevenue } from "@/lib/services/balance.service";
import { checkSpendCap, spendCapMessage } from "@/lib/services/spend-cap.service";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { checkRateLimit } from "@/lib/redis";
import config from "@/lib/config";
import { PAID_MESSAGE_PRICE } from "@/lib/pay-message";
import { z } from "zod";

/**
 * The budget for the send-message transaction.
 *
 * Prisma's default is 5 seconds and it measures the DATABASE, not the work. A
 * charged message runs debitWallet, the message row, a balance upsert, the
 * ledger row and a notification — five round trips — and on this deployment a
 * pooled Postgres query measures ~0.5 s each, so the defaults roll back a send
 * that did nothing wrong. A rolled-back send is the exact "the message never
 * arrived" report, so the budget is set where the work actually fits. Same
 * values as the blue-tick charge, which hit the same wall.
 */
const MESSAGE_TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

const sendMessageSchema = z.object({
  receiverId: z.string().min(1),
  // Deliberately no `amount`. What a message costs is the platform's price, not
  // the caller's choice — see PAID_MESSAGE_PRICE. A field here would be a field
  // a scripted client could set, which is how a "100 per message" rule becomes a
  // rule only the UI follows; a stale tab's amount is simply ignored.
  content: z.string().min(1).max(2000),
});

// POST /api/messages
export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth();

    // Keyed on the sender, not the IP: unsolicited DMs are the top abuse vector
    // on a creator platform, and a per-account limit is the one an abuser cannot
    // rotate by changing networks.
    const { allowed } = await checkRateLimit(
      `msg:${auth.userId}`,
      config.rateLimit.general.max,
      config.rateLimit.general.windowMs
    );
    if (!allowed) return api.rateLimited("Too many messages — please wait a moment");

    const body = await readJsonBody(request);
    const result = sendMessageSchema.safeParse(body);
    if (!result.success) return api.validation(result.error.errors[0].message);

    const { receiverId, content } = result.data;

    if (receiverId === auth.userId) {
      return api.error("You cannot message yourself");
    }

    // Verify receiver exists
    const receiver = await prisma.user.findUnique({
      where: { id: receiverId },
      select: { id: true, isBanned: true, role: true, messagesEnabled: true },
    });
    if (!receiver || receiver.isBanned) return api.notFound("This user does not exist");

    // The inbox switch. Checked here rather than merely hidden in the UI: a
    // creator who closed their inbox is not reachable from the API either, or
    // the toggle would only hide the button while the messages kept arriving.
    if (receiver.messagesEnabled === false) {
      return api.error(
        "This user has turned messages off, so they cannot receive new messages right now."
      );
    }

    // Who is allowed to answer without paying.
    //
    // A viewer pays to start and to continue a conversation — that is the
    // product, and it is unchanged. A creator answering their own inbox does
    // NOT: charging them made a reply impossible for anyone whose wallet was
    // empty (every creator's money sits in earnings, not in the wallet), and it
    // turned the inbox into a one-way channel in which a fan could pay to be
    // heard and hear nothing back.
    //
    // Read from the database, not from the token: a role can change long before
    // a seven-day session is reissued, and this decides who pays.
    const sender = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { role: true },
    });
    const freeReply = sender?.role === "CREATOR" || sender?.role === "ADMIN";

    // A creator's inbox is for their subscribers. A viewer can only write to a
    // creator they are subscribed to; the subscription is the door, and the
    // fixed price below is still the price of the message once inside. Checked
    // server-side so hiding the composer is not the whole control — an
    // unsubscribed viewer posting straight to this route is refused here.
    if (!freeReply && receiver.role === "CREATOR") {
      const subscription = await prisma.creatorSubscription.findFirst({
        where: {
          viewerId: auth.userId,
          creatorId: receiverId,
          isActive: true,
          expiresAt: { gt: new Date() },
        },
        select: { id: true },
      });
      if (!subscription) {
        return api.error(
          "Subscribe to this creator before sending them a message.",
          403,
          "SUBSCRIPTION_REQUIRED"
        );
      }
    }

    /**
     * What is actually taken: the fixed price for a viewer, nothing for a reply
     * from a creator or an admin.
     *
     * Always the constant, never the request, so the shillings a fan is charged
     * are the same ones the composer told them about before they wrote — and a
     * client cannot decide its own price either way.
     */
    const charged = freeReply ? 0 : PAID_MESSAGE_PRICE;

    // The daily spend cap, checked before the transaction so a refusal costs
    // nothing and leaves no half-written charge. A free reply (charged 0) is
    // never capped — a creator answering is not spending.
    if (charged > 0) {
      const spendCap = await checkSpendCap(auth.userId, charged);
      if (!spendCap.allowed) {
        return api.error(spendCapMessage(spendCap), 429, "SPEND_CAP");
      }
    }

    // The same 70/30 split every other sale on the platform uses. The sender pays
    // the amount they chose; the platform takes its fee from it and the receiver
    // gets the rest — a paid message is not an exception to the promise /about
    // makes, and the two halves always add back up to what was charged. A free
    // reply splits 0, so nothing is invented for anyone.
    const { platformFee, creatorCut } = splitRevenue(charged);

    const message = await prisma.$transaction(async (tx) => {
      if (charged > 0) {
        // The balance check and the deduction are one statement (debitWallet).
        // Checking with a read first let two messages start on one balance.
        const debited = await debitWallet(tx, { userId: auth.userId, amount: charged });
        if (!debited.ok) {
          return { insufficient: true as const, balance: debited.balance };
        }
      }

      // Create message
      // deliveredAt defaults to now() at the database, so the commit itself is
      // the delivery receipt — the money is taken and the message is durable in
      // the same transaction, which is the whole "end to end" guarantee: there is
      // no window where a viewer is charged and nothing is stored.
      const msg = await tx.payMessage.create({
        data: {
          senderId: auth.userId,
          receiverId,
          amount: charged,
          content,
        },
      });

      // Nothing to split when nothing was charged: no creator balance moves, no
      // wallet is credited, and no ledger row is written. A ledger entry for a
      // free message would be a transaction of 0 that every earnings and revenue
      // read would then have to know to ignore.
      if (charged === 0) {
        await tx.notification.create({
          data: {
            userId: receiverId,
            title: "New message 💬",
            message: `${sender?.role === "ADMIN" ? "Genhub support" : "The creator"} replied to you.`,
            type: "info",
            link: "/inbox",
          },
        });
        return msg;
      }

      if (receiver.role === "CREATOR") {
        // Credit creator's pending balance (14-day holding, like a purchase)
        await tx.creatorBalance.upsert({
          where: { creatorId: receiverId },
          create: {
            creatorId: receiverId,
            pendingBalance: creatorCut,
            availableBalance: 0,
            totalEarned: creatorCut,
          },
          update: {
            pendingBalance: { increment: creatorCut },
            totalEarned: { increment: creatorCut },
          },
        });
      } else {
        // A paid message to an ordinary account. Their share goes where every
        // other incoming payment goes — their wallet. Writing a CreatorBalance row
        // instead (what this route used to do) invented a creator who does not
        // exist and held their money for 14 days against a payout they cannot
        // request.
        await tx.user.update({
          where: { id: receiverId },
          data: { walletBalance: { increment: creatorCut } },
        });
      }

      // Create transaction record. The fee breakdown is recorded the same way a
      // purchase records it, so the platform's cut on chat is countable rather
      // than implied by the difference between two numbers.
      await tx.transaction.create({
        data: {
          userId: auth.userId,
          creatorId: receiver.role === "CREATOR" ? receiverId : null,
          amount: charged,
          platformFee,
          type: "TIP",
          status: "SUCCESS",
          creatorCut,
          metadata: { method: "pay_message", recipientId: receiverId },
        },
      });

      // Notify receiver. Both figures, because the sender paid one and the
      // receiver only ever sees the other in their balance.
      await tx.notification.create({
        data: {
          userId: receiverId,
          title: "New message 💬",
          message: `You received a paid message worth TZS ${charged.toLocaleString()} — your share is TZS ${creatorCut.toLocaleString()}`,
          type: "info",
          link: "/inbox",
        },
      });

      return msg;
    }, MESSAGE_TX_OPTIONS);

    if ("insufficient" in message) {
      return api.error(
        `Your wallet balance is too low (TZS ${message.balance.toLocaleString()})`
      );
    }

    return api.success(message, "Message sent", 201);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Send Message Error]", error);
    return api.internal();
  }
}

// GET /api/messages?userId=xxx → thread; without userId → inbox conversation list
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth();
    const userId = request.nextUrl.searchParams.get("userId");

    if (!userId) {
      // Inbox: grouped conversation list for the current user
      const recent = await prisma.payMessage.findMany({
        where: {
          OR: [{ senderId: auth.userId }, { receiverId: auth.userId }],
        },
        orderBy: { createdAt: "desc" },
        take: 300,
        include: {
          sender: {
            select: { id: true, username: true, displayName: true, avatarUrl: true, role: true },
          },
          receiver: {
            select: { id: true, username: true, displayName: true, avatarUrl: true, role: true },
          },
        },
      });

      const conversations = new Map<
        string,
        {
          partner: {
            id: string;
            username: string | null;
            displayName: string | null;
            avatarUrl: string | null;
            role: string;
          };
          lastMessage: (typeof recent)[number];
          unreadCount: number;
        }
      >();

      for (const m of recent) {
        const partner = m.senderId === auth.userId ? m.receiver : m.sender;
        if (!partner) continue;
        if (!conversations.has(partner.id)) {
          conversations.set(partner.id, { partner, lastMessage: m, unreadCount: 0 });
        }
        const entry = conversations.get(partner.id)!;
        if (m.receiverId === auth.userId && !m.isRead) {
          entry.unreadCount += 1;
        }
      }

      return api.success({ conversations: Array.from(conversations.values()) });
    }

    const messages = await prisma.payMessage.findMany({
      where: {
        OR: [
          { senderId: auth.userId, receiverId: userId },
          { senderId: userId, receiverId: auth.userId },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        sender: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
      },
    });

    // Mark as read, and stamp WHEN. `isRead` alone answered "has it been seen";
    // readAt answers "when", which is what the sender's "Read" bubble needs.
    await prisma.payMessage.updateMany({
      where: { senderId: userId, receiverId: auth.userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });

    return api.success(messages);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Get Messages Error]", error);
    return api.internal();
  }
}
