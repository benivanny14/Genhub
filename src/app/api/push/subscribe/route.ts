// =============================================================================
// GENHUB - Push subscription registry
//
// POST   /api/push/subscribe — remember (or refresh) one device's subscription.
// DELETE /api/push/subscribe — forget it, when the person turns push off.
//
// The endpoint is the device's identity and is @unique in the schema, so this is
// an upsert: re-subscribing the same browser (the keys rotate) must update the
// row, not create a second one that would deliver the same notification twice.
// =============================================================================

import { NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { readJsonBody } from "@/lib/request-body";

const subscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth: z.string().min(1).max(500),
  }),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth();

    const body = await readJsonBody(request, {});
    const parsed = subscribeSchema.safeParse(body);
    if (!parsed.success) return api.validation("That subscription is not valid");

    const { endpoint, keys } = parsed.data;
    const userAgent = request.headers.get("user-agent")?.slice(0, 300) ?? null;

    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { userId: auth.userId, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent },
      // Reassigned to whoever is signed in NOW: a shared browser that switched
      // accounts must deliver to the current account, not the previous one.
      update: { userId: auth.userId, p256dh: keys.p256dh, auth: keys.auth, userAgent },
    });

    return api.success({ subscribed: true }, "Notifications are on");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized();
    }
    console.error("[Push Subscribe Error]", error);
    return api.internal();
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const auth = await requireAuth();

    const body = await readJsonBody(request, {});
    const endpoint = body?.endpoint?.toString();
    if (!endpoint) return api.validation("endpoint is required");

    // Scoped to this user: one account cannot delete another's device.
    await prisma.pushSubscription.deleteMany({ where: { userId: auth.userId, endpoint } });

    return api.success({ subscribed: false }, "Notifications are off");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized();
    }
    console.error("[Push Unsubscribe Error]", error);
    return api.internal();
  }
}
