// =============================================================================
// GENHUB - Bunny.net Upload Credentials Route
// POST /api/videos/upload-signature
//
// Reserves a video slot in Bunny Stream and returns the presigned TUS
// credentials the creator's browser uploads the file with. The library API key
// stays on this server — see createTusCredentials() in lib/bunny.ts for why the
// browser cannot talk to the management API itself.
// =============================================================================

import { NextRequest } from "next/server";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { createVideoUpload } from "@/lib/bunny";
import config from "@/lib/config";

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRole("CREATOR");

    // Verify KYC is approved
    const prisma = (await import("@/lib/db")).default;

    const user = await prisma.user.findUnique({
      where: { id: auth.userId },
      select: { kycStatus: true, isBanned: true },
    });

    if (!user || user.kycStatus !== "APPROVED") {
      return api.forbidden("Your KYC must be approved before you can upload videos");
    }

    if (user.isBanned) {
      return api.forbidden("Your account is blocked");
    }

    // Bunny Stream must be configured before we can create an upload target;
    // return a clear configuration error instead of an opaque 500.
    if (!config.bunny.libraryId || !config.bunny.apiKey) {
      return api.error(
        "Bunny Stream is not configured (BUNNY_STREAM_LIBRARY_ID / BUNNY_STREAM_API_KEY)",
        503,
        "NOT_CONFIGURED"
      );
    }

    const body = await request.json().catch(() => ({}));
    const title = body.title || `Video ${Date.now()}`;

    const result = await createVideoUpload(title);

    return api.success(result, "Upload credentials created");
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Upload Signature Error]", error);
    return api.internal();
  }
}
