// =============================================================================
// GENHUB - Logout API Route
// POST /api/auth/logout
// =============================================================================

import { removeAuthCookie } from "@/lib/auth";
import { api } from "@/lib/api-response";

export async function POST() {
  try {
    await removeAuthCookie();
    return api.success(null, "Umetoka kikamilifu");
  } catch (error) {
    console.error("[Logout Error]", error);
    return api.internal();
  }
}
