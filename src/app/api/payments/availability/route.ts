// =============================================================================
// GENHUB - Can this deployment take a mobile-money payment right now?
// GET /api/payments/availability
//
// Public on purpose. The paywall and the wallet read it before they offer a Pay
// button, and both are shown to signed-out visitors — so a route behind a
// session would be read by nobody it is for.
//
// It reports two facts and one decision:
//   breakerOpen  the local circuit breaker has temporarily stopped calling
//                ClickPesa because it stopped answering. This is the state that
//                produced "something went wrong" for a customer who did nothing
//                wrong.
//   sandbox      checkout is simulated (a dev build, or PAYMENT_SANDBOX=true),
//                so there is nothing to be unavailable about.
//   available    whether starting a payment can succeed at all.
//
// `reason` is a machine-readable code ("gateway-unreachable", "not-configured",
// "sandbox", "ok") so the client can choose its own sentence rather than parse
// one. Nothing here identifies a key, a host or a customer.
// =============================================================================

import config from "@/lib/config";
import { api } from "@/lib/api-response";
import { resolvePaymentGateway } from "@/lib/payments/gateway";

export const dynamic = "force-dynamic";

export async function GET() {
  // Resolved through the registry, not the integration file, so this route
  // stays unaware of which gateway is behind it.
  const gateway = resolvePaymentGateway("CLICKPESA");
  const breaker = gateway.breakerState();
  const sandbox = config.clickPesa.sandbox;
  const configured = gateway.isConfigured();

  // Sandbox simulates the charge, so it is always "available" — a dev build must
  // not disable its own Pay button because no live key is set.
  const available = sandbox || (configured && !breaker.open);

  const reason = breaker.open
    ? "gateway-unreachable"
    : !sandbox && !configured
      ? "not-configured"
      : sandbox
        ? "sandbox"
        : "ok";

  return api.success({
    available,
    reason,
    breakerOpen: breaker.open,
    breakerOpenUntil: breaker.open ? new Date(breaker.openUntil).toISOString() : null,
    sandbox,
    checkedAt: new Date().toISOString(),
  });
}
