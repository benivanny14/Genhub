// =============================================================================
// GENHUB - Admin Coupons API Route
// GET /api/admin/coupons - List all coupons
// POST /api/admin/coupons - Create a coupon
// DELETE /api/admin/coupons?id= - Toggle/delete a coupon
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { createCouponSchema } from "@/lib/validation";

export async function GET(request: NextRequest) {
  try {
    await requireRole("ADMIN");

    const coupons = await prisma.coupon.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    return api.success({ coupons });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin List Coupons Error]", error);
    return api.internal();
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireRole("ADMIN");

    const body = await request.json();
    const result = createCouponSchema.safeParse(body);
    if (!result.success) {
      return api.validation(result.error.errors[0].message);
    }

    const { code, type, value, maxUses, expiresInDays } = result.data;
    const upper = code.toUpperCase();

    const existing = await prisma.coupon.findUnique({ where: { code: upper } });
    if (existing) return api.error("This coupon already exists", 409, "DUPLICATE");

    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 86400000)
      : null;

    const coupon = await prisma.coupon.create({
      data: {
        code: upper,
        type,
        value,
        maxUses: maxUses ?? null,
        expiresAt,
      },
    });

    return api.success(coupon, "Coupon created", 201);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Create Coupon Error]", error);
    return api.internal();
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await requireRole("ADMIN");

    const id = request.nextUrl.searchParams.get("id");
    if (!id) return api.validation("id is required");

    const coupon = await prisma.coupon.findUnique({ where: { id } });
    if (!coupon) return api.notFound("Coupon not found");

    // Soft toggle: deactivate instead of deleting so past uses stay auditable
    const updated = await prisma.coupon.update({
      where: { id },
      data: { isActive: !coupon.isActive },
    });

    return api.success(updated, updated.isActive ? "Coupon updated" : "Kuzimwa");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Toggle Coupon Error]", error);
    return api.internal();
  }
}
