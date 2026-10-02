// =============================================================================
// GENHUB - One charge's journey, for the admin Payments panel
// GET /api/admin/payments/journey?transactionId=… (ADMIN)
//
// The panel showed `FAILED` and nothing else. This returns the timeline behind
// that word: when the checkout was created, how many times the gateway was
// asked to collect, exactly what it answered when it refused, whether a webhook
// ever arrived, and what the customer was shown — see
// src/lib/services/payment-journey.service.ts.
//
// Read-only and admin-only: it names the viewer, the gateway error and the
// event metadata.
// =============================================================================

import { NextRequest } from "next/server";
import { requireRole, AuthError } from "@/lib/auth";
import { api } from "@/lib/api-response";
import { getPaymentJourney } from "@/lib/services/payment-journey.service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireRole("ADMIN");

    const transactionId = (request.nextUrl.searchParams.get("transactionId") || "").trim();
    if (!transactionId) return api.validation("transactionId is required");

    const journey = await getPaymentJourney(transactionId);
    if (!journey) return api.notFound("Charge not found");

    return api.success(journey);
  } catch (error) {
    if (error instanceof AuthError) {
      return error.statusCode === 403 ? api.forbidden(error.message) : api.unauthorized(error.message);
    }
    console.error("[Admin Payment Journey Error]", error);
    return api.internal();
  }
}
