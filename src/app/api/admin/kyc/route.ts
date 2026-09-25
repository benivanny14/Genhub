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
import { AUDIT_ACTIONS, recordAudit } from "@/lib/services/audit.service";

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
      include: { user: { select: { displayName: true, email: true } } },
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

    // Identity decisions are the ones a platform is asked to justify. The
    // document URLs are deliberately NOT copied into the log: the entry says who
    // was approved and on what basis, it does not become a second copy of
    // somebody's NIDA card.
    await recordAudit({
      actorId: auth.userId,
      action: status === "APPROVED" ? AUDIT_ACTIONS.kycApprove : AUDIT_ACTIONS.kycReject,
      targetType: "KycVerification",
      targetId: kycId,
      summary: `${status === "APPROVED" ? "Approved" : "Rejected"} KYC for ${
        kyc.user?.displayName || kyc.user?.email || kyc.userId
      }${rejectionReason ? ` — ${rejectionReason}` : ""}`,
      detail: {
        userId: kyc.userId,
        rejectionReason: rejectionReason ?? null,
        idDocumentType: kyc.idDocumentType,
      },
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
