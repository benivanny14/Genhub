// =============================================================================
// GENHUB - Creator Application Status API Route
// GET /api/account/creator-application - Returns what the current user needs
// to finish onboarding (role, KYC state) so the /become-creator page can show
// the right next step.
// =============================================================================

import prisma from "@/lib/db";
import { requireAuth, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";

export async function GET() {
  try {
    const auth = await requireAuth();

    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: {
        role: true,
        kycStatus: true,
        isBanned: true,
        displayName: true,
        creatorBalance: { select: { totalEarned: true } },
      },
    });

    if (!user) return api.notFound("This user no longer exists");

    const step =
      user.role === "ADMIN"
        ? "admin"
        : user.role === "CREATOR"
          ? user.kycStatus === "APPROVED"
            ? "dashboard"
            : "kyc"
          : "upgrade";

    return api.success({
      role: user.role,
      kycStatus: user.kycStatus,
      isBanned: user.isBanned,
      step,
      nextPath:
        step === "dashboard" ? "/creator" : step === "kyc" ? "/creator/kyc" : null,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Creator Application Error]", error);
    return api.internal();
  }
}
