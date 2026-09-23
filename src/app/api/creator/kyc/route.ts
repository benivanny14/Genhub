// =============================================================================
// GENHUB - Creator KYC Submission Route
// POST /api/creator/kyc - Submit KYC verification
// GET /api/creator/kyc - Get KYC status
// =============================================================================

import { NextRequest } from "next/server";
import prisma from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { submitKycSchema } from "@/lib/validation";

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    // Check existing KYC
    const existing = await prisma.kycVerification.findFirst({
      where: {
        userId: auth.userId,
        status: { in: ["PENDING", "APPROVED"] },
      },
    });

    if (existing) {
      return api.error(
        existing.status === "APPROVED"
          ? "Your KYC is already approved"
          : "Your KYC is already under review. Please wait.",
        409
      );
    }

    const body = await request.json();
    const result = submitKycSchema.safeParse(body);

    if (!result.success) {
      return api.validation(result.error.errors[0].message);
    }

    const { idDocumentUrl, selfieUrl, idDocumentType } = result.data;

    // Create KYC verification request
    const kyc = await prisma.kycVerification.create({
      data: {
        userId: auth.userId,
        idDocumentUrl,
        selfieUrl,
        idDocumentType,
        status: "PENDING",
      },
    });

    // Update user KYC status
    await prisma.user.update({
      where: { id: auth.userId },
      data: { kycStatus: "PENDING" },
    });

    return api.success(kyc, "KYC submitted. Awaiting review.", 201);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[KYC Submit Error]", error);
    return api.internal();
  }
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    const kyc = await prisma.kycVerification.findFirst({
      where: { userId: auth.userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        rejectionReason: true,
        createdAt: true,
        reviewedAt: true,
      },
    });

    return api.success(kyc || { status: "NONE" });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[KYC Status Error]", error);
    return api.internal();
  }
}
