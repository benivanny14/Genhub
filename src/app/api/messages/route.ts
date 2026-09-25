// =============================================================================
// GENHUB - Pay-to-Chat Messages API Route
// POST /api/messages - Send a paid message
// GET /api/messages - Get messages for a conversation
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { debitWallet } from "@/lib/services/balance.service";
import { api } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/redis";
import config from "@/lib/config";
import {
  MAX_PAID_MESSAGE,
  MIN_PAID_MESSAGE,
  type PayMessageFreeReason,
} from "@/lib/pay-message";
import { z } from "zod";

const sendMessageSchema = z.object({
  receiverId: z.string().min(1),
  // 0 is MEANINGFUL here, not a missing value.
  //
  // Two senders owe nothing: a viewer writing to a creator they hold an active
  // subscription to (free chat for the paid month — the same promise the video
  // paywall keeps), and a creator answering someone who is in their inbox. The
  // old schema demanded at least TZS 100, so the server rejected the exact case
  // the product promises is free, and the subscriber was told to pay again.
  // Whether a charge applies is decided below, from the database, never from
  // the number the client sent.
  amount: z.number().int().min(0).max(MAX_PAID_MESSAGE).default(0),
  content: z.string().min(1).max(2000),
});

/** Why a message cost nothing. Null when it was paid for. */
type FreeReason = PayMessageFreeReason;

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

    const body = await request.json();
    const result = sendMessageSchema.safeParse(body);
    if (!result.success) return api.validation(result.error.errors[0].message);

    const { receiverId, amount, content } = result.data;

    if (receiverId === auth.userId) {
      return api.error("You cannot message yourself");
    }

    // Verify receiver exists
    const receiver = await prisma.user.findUnique({
      where: { id: receiverId },
      select: { id: true, isBanned: true, role: true },
    });
    if (!receiver || receiver.isBanned) return api.notFound("This user does not exist");

    // ---------------------------------------------------------------------
    // Who pays, and who does not
    //
    // Three reads, one round trip. Each answers a different question the old
    // route never asked:
    //
    //   senderSubscription   does the sender hold an active membership to this
    //                        creator? Then the month they paid for buys free
    //                        chat, not only free video.
    //   receiverSubscription the receiver holds an active membership to the
    //                        SENDER, so this is the creator answering their own
    //                        subscriber — charging them would be taking money
    //                        from the creator to pay the fan.
    //   wroteFirst          the receiver started this thread. A creator can
    //                        always answer someone who wrote to them; otherwise
    //                        replying cost the creator their own money, and the
    //                        "reply" was credited into a fake CreatorBalance row
    //                        for a viewer who can never request a payout.
    // ---------------------------------------------------------------------
    const now = new Date();
    const activeSubscription = {
      isActive: true,
      expiresAt: { gt: now },
    } as const;

    const [senderSubscription, receiverSubscription, wroteFirst] = await Promise.all([
      prisma.creatorSubscription.findFirst({
        where: { viewerId: auth.userId, creatorId: receiverId, ...activeSubscription },
        select: { expiresAt: true },
      }),
      prisma.creatorSubscription.findFirst({
        where: { viewerId: receiverId, creatorId: auth.userId, ...activeSubscription },
        select: { id: true },
      }),
      prisma.payMessage.findFirst({
        where: { senderId: receiverId, receiverId: auth.userId },
        select: { id: true },
      }),
    ]);

    const freeReason: FreeReason | null = senderSubscription
      ? "subscription"
      : receiverSubscription || (auth.role === "CREATOR" && wroteFirst)
        ? "reply"
        : null;

    const charge = freeReason ? 0 : amount;

    if (!freeReason && charge < MIN_PAID_MESSAGE) {
      return api.validation(
        `A paid message starts at TZS ${MIN_PAID_MESSAGE} — or subscribe to this creator and write to them free for a month`
      );
    }

    const message = await prisma.$transaction(async (tx) => {
      if (charge > 0) {
        // The balance check and the deduction are one statement (debitWallet).
        // Checking with a read first let two messages start on one balance.
        const debited = await debitWallet(tx, { userId: auth.userId, amount: charge });
        if (!debited.ok) {
          return { insufficient: true as const, balance: debited.balance };
        }
      }

      // Create message
      const msg = await tx.payMessage.create({
        data: {
          senderId: auth.userId,
          receiverId,
          amount: charge,
          content,
        },
      });

      if (charge > 0) {
        if (receiver.role === "CREATOR") {
          // Credit creator's pending balance (14-day holding, like a purchase)
          await tx.creatorBalance.upsert({
            where: { creatorId: receiverId },
            create: {
              creatorId: receiverId,
              pendingBalance: charge,
              availableBalance: 0,
              totalEarned: charge,
            },
            update: {
              pendingBalance: { increment: charge },
              totalEarned: { increment: charge },
            },
          });
        } else {
          // A paid message to an ordinary account. The money is theirs, so it
          // goes where every other incoming payment goes — their wallet.
          // Writing a CreatorBalance row instead (what this route used to do)
          // invented a creator who does not exist and held their money for 14
          // days against a payout they cannot request.
          await tx.user.update({
            where: { id: receiverId },
            data: { walletBalance: { increment: charge } },
          });
        }

        // Create transaction record
        await tx.transaction.create({
          data: {
            userId: auth.userId,
            creatorId: receiver.role === "CREATOR" ? receiverId : null,
            amount: charge,
            type: "TIP",
            status: "SUCCESS",
            creatorCut: charge,
            metadata: { method: "pay_message", recipientId: receiverId },
          },
        });
      }

      // Notify receiver
      await tx.notification.create({
        data: {
          userId: receiverId,
          title: "New message 💬",
          message:
            charge > 0
              ? `You received a paid message worth TZS ${charge.toLocaleString()}`
              : freeReason === "subscription"
                ? "A subscriber sent you a message"
                : "You have a new message",
          type: "info",
          link: "/inbox",
        },
      });

      return msg;
    });

    if ("insufficient" in message) {
      return api.error(
        `Your wallet balance is too low (TZS ${message.balance.toLocaleString()})`
      );
    }

    return api.success(
      {
        ...message,
        // So the composer can say "included in your subscription" instead of
        // guessing from the amount it happens to hold.
        paid: charge > 0,
        freeReason,
        subscriptionExpiresAt: senderSubscription?.expiresAt ?? null,
      },
      "Message sent",
      201
    );
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
            select: { id: true, displayName: true, avatarUrl: true, role: true },
          },
          receiver: {
            select: { id: true, displayName: true, avatarUrl: true, role: true },
          },
        },
      });

      const conversations = new Map<
        string,
        {
          partner: { id: string; displayName: string | null; avatarUrl: string | null; role: string };
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
        sender: { select: { id: true, displayName: true, avatarUrl: true } },
      },
    });

    // Mark as read
    await prisma.payMessage.updateMany({
      where: { senderId: userId, receiverId: auth.userId, isRead: false },
      data: { isRead: true },
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
