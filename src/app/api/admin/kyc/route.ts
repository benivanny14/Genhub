// =============================================================================
// GENHUB - Admin KYC Review Route
// GET /api/admin/kyc - List pending KYC verifications
// POST /api/admin/kyc - Approve or reject KYC
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { reviewKycSchema } from "@/lib/validation";

export async function GET(request: NextRequest) {
  try {
    await requireRole("ADMIN");

    const searchParams = request.nextUrl.searchParams;
    const status = searchParams.get("status") || "PENDING";
    const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
    const limit = Math.min(50, parseInt(searchParams.get("limit") || "20"));

    const [kycs, total] = await Promise.all([
      prisma.kycVerification.findMany({
        where: { status: status as any },
        orderBy: { createdAt: "asc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: {
            select: {
              id: true,
              displayName: true,
              email: true,
              phone: true,
              createdAt: true,
            },
          },
        },
      }),
      prisma.kycVerification.count({ where: { status: status as any } }),
    ]);

    return api.success({
      kycs,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin KYC List Error]", error);
    return api.internal();
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("ADMIN");

    const body = await request.json();
    const result = reviewKycSchema.safeParse(body);

    if (!result.success) {
      return api.validation(result.error.errors[0].message);
    }

    const { kycId, status, rejectionReason } = result.data;

    const kyc = await prisma.kycVerification.findUnique({
      where: { id: kycId },
    });

    if (!kyc) return api.notFound("KYC submission not found");

    await prisma.$transaction(async (tx) => {
      await tx.kycVerification.update({
        where: { id: kycId },
        data: {
          status,
          rejectionReason: rejectionReason || null,
          reviewedBy: auth.userId,
          reviewedAt: new Date(),
        },
      });

      await tx.user.update({
        where: { id: kyc.userId },
        data: { kycStatus: status },
      });
    });

    return api.success(
      null,
      status === "APPROVED" ? "KYC approved" : "KYC imekataliwa"
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin KYC Review Error]", error);
    return api.internal();
  }
}
