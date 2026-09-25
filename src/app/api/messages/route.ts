// =============================================================================
// GENHUB - Pay-to-Chat Messages API Route
// POST /api/messages - Send a paid message
// GET /api/messages - Get messages for a conversation
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { debitWallet, splitRevenue } from "@/lib/services/balance.service";
import { api } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/redis";
import config from "@/lib/config";
import { MAX_PAID_MESSAGE, MIN_PAID_MESSAGE } from "@/lib/pay-message";
import { z } from "zod";

const sendMessageSchema = z.object({
  receiverId: z.string().min(1),
  // Every message is a paid message. There is no free chat and no exemption
  // list: a subscription buys a creator's *videos* for a month, not their inbox,
  // and a creator answering a fan pays like anybody else. 0 is therefore a
  // missing amount, not a meaningful one, and the server charges exactly what
  // the request asks for.
  amount: z
    .number()
    .int()
    .min(MIN_PAID_MESSAGE, `The minimum amount is TZS ${MIN_PAID_MESSAGE}`)
    .max(MAX_PAID_MESSAGE),
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

    // The same 70/30 split every other sale on the platform uses. The sender pays
    // the amount they chose; the platform takes its fee from it and the receiver
    // gets the rest — a paid message is not an exception to the promise /about
    // makes, and the two halves always add back up to what was charged.
    const { platformFee, creatorCut } = splitRevenue(amount);

    const message = await prisma.$transaction(async (tx) => {
      // The balance check and the deduction are one statement (debitWallet).
      // Checking with a read first let two messages start on one balance.
      const debited = await debitWallet(tx, { userId: auth.userId, amount });
      if (!debited.ok) {
        return { insufficient: true as const, balance: debited.balance };
      }

      // Create message
      const msg = await tx.payMessage.create({
        data: {
          senderId: auth.userId,
          receiverId,
          amount,
          content,
        },
      });

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
          amount,
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
          message: `You received a paid message worth TZS ${amount.toLocaleString()} — your share is TZS ${creatorCut.toLocaleString()}`,
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
