// =============================================================================
// GENHUB - Appeals
//
// POST /api/appeals — a suspended or rejected account asks to be reinstated.
// GET  /api/appeals — that account reads its own appeals and their status.
//
// The person filing one may already be blocked from using the site (the ban is
// what they are appealing), so this route takes a ban into account: it refuses
// only a second open appeal, never the first one. Rate-limited, and the text is
// bounded so it is a message and not a place to store a file.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/services/audit.service";

const KINDS = ["BAN", "KYC", "CONTENT"] as const;
const MAX_MESSAGE = 2000;

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth();

    const body = await readJsonBody(request, {});
    const kind = KINDS.includes(body?.kind) ? (body.kind as string) : "BAN";
    const message = body?.message?.toString().trim().slice(0, MAX_MESSAGE);

    if (!message || message.length < 10) {
      return api.validation("Tell us briefly why we should take another look");
    }

    // One open appeal at a time: a queue full of duplicates from one account is
    // how a real case gets missed.
    const open = await prisma.appeal.findFirst({
      where: { userId: auth.userId, status: "PENDING" },
      select: { id: true, createdAt: true },
    });
    if (open) {
      return api.error(
        "You already have an appeal in review. We will get back to you — please do not send another.",
        409,
        "APPEAL_PENDING"
      );
    }

    const appeal = await prisma.appeal.create({
      data: { userId: auth.userId, kind, message },
      select: { id: true, kind: true, status: true, createdAt: true },
    });

    await recordAudit({
      actorId: auth.userId,
      action: AUDIT_ACTIONS.appealSubmitted,
      targetType: "User",
      targetId: auth.userId,
      summary: `Filed a ${kind.toLowerCase()} appeal`,
      detail: { appealId: appeal.id },
    });

    return api.success(appeal, "Appeal received — we will review it soon", 201);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized();
    }
    console.error("[Appeal Submit Error]", error);
    return api.internal();
  }
}

export async function GET() {
  try {
    const auth = await requireAuth();
    const appeals = await prisma.appeal.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        kind: true,
        message: true,
        status: true,
        reviewerNote: true,
        reviewedAt: true,
        createdAt: true,
      },
    });
    return api.privateSuccess(appeals);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized();
    }
    console.error("[Appeal List Error]", error);
    return api.internal();
  }
}
