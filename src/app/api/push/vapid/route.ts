// =============================================================================
// GENHUB - The public half of push
//
// GET /api/push/vapid — the VAPID public key a browser needs to subscribe, and
// whether push works at all on this deployment. Public on purpose (it is a
// public key), and cacheable, because the client asks for it once per device.
// =============================================================================

import { api } from "@/lib/api-response";
import { getVapidPublicKey, isPushConfigured } from "@/lib/services/push.service";

export async function GET() {
  const publicKey = getVapidPublicKey();
  return api.success({ configured: isPushConfigured(), publicKey });
}
