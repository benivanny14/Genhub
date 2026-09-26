// =============================================================================
// GENHUB - Message settings
// GET   /api/messages/settings - is my inbox open?
// PATCH /api/messages/settings - open or close my inbox
//
// A creator can turn their inbox off and on at will. It is a deliberate one-way
// switch with a clear meaning: OFF means nobody can start or continue paying to
// write to me. Turning it back on restores the inbox exactly as it was — the
// messages already received are never deleted, so a creator who flips it off in
// anger does not lose the fans who paid to reach them.
//
// The flag lives on User rather than CreatorProfile because viewers receive paid
// messages too (the platform credits their wallet, see POST /api/messages), and
// everyone deserves the same switch over who can reach them.
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";

export async function GET() {
  try {
    const auth = await requireAuth();
    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { messagesEnabled: true, role: true },
    });
    return api.success({ messagesEnabled: user?.messagesEnabled ?? true });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized();
    }
    console.error("[Message Settings GET Error]", error);
    return api.internal();
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireAuth();
    const body = await request.json();

    if (typeof body?.messagesEnabled !== "boolean") {
      return api.validation("messagesEnabled must be true or false");
    }

    await prisma.user.update({
      where: { id: auth.userId },
      data: { messagesEnabled: body.messagesEnabled },
    });

    return api.success(
      { messagesEnabled: body.messagesEnabled },
      body.messagesEnabled ? "Messages turned on" : "Messages turned off"
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized();
    }
    console.error("[Message Settings PATCH Error]", error);
    return api.internal();
  }
}
