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
import { z } from "zod";

const sendMessageSchema = z.object({
  receiverId: z.string().min(1),
  amount: z.number().int().min(100, "The minimum amount is TZS 100").max(50000),
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
      select: { id: true, isBanned: true },
    });
    if (!receiver || receiver.isBanned) return api.notFound("This user does not exist");

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

      // Credit creator's pending balance
      await tx.creatorBalance.upsert({
        where: { creatorId: receiverId },
        create: {
          creatorId: receiverId,
          pendingBalance: amount,
          availableBalance: 0,
          totalEarned: amount,
        },
        update: {
          pendingBalance: { increment: amount },
          totalEarned: { increment: amount },
        },
      });

      // Create transaction record
      await tx.transaction.create({
        data: {
          userId: auth.userId,
          creatorId: receiverId,
          amount,
          type: "TIP",
          status: "SUCCESS",
          creatorCut: amount,
        },
      });

      // Notify receiver
      await tx.notification.create({
        data: {
          userId: receiverId,
          title: "New message 💬",
          message: `You received a paid message worth TZS ${amount.toLocaleString()}`,

          type: "info",
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
