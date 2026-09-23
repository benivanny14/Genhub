// =============================================================================
// GENHUB - Payment gateway lock
// HarakaPay is the ONLY payment gateway. Every payment entry point and the
// settlement choke point import from here, so a legacy gateway can never be
// wired back in silently: an unexpected value fails loudly instead of quietly
// routing money somewhere else.
// =============================================================================

export const SUPPORTED_GATEWAYS = ["HARAKAPAY"] as const;
export type SupportedGateway = (typeof SUPPORTED_GATEWAYS)[number];

/**
 * `provider` labels allowed to reach settlement. HarakaPay is the only real
 * gateway; SANDBOX is the local-dev marker emitted by POST /api/dev/sandbox.
 */
const SETTLEMENT_PROVIDERS: readonly string[] = [...SUPPORTED_GATEWAYS, "SANDBOX"];

export function isSupportedGateway(value: unknown): value is SupportedGateway {
  return (
    typeof value === "string" && (SUPPORTED_GATEWAYS as readonly string[]).includes(value)
  );
}

export function isSupportedSettlementProvider(provider: unknown): boolean {
  return typeof provider === "string" && SETTLEMENT_PROVIDERS.includes(provider);
}

/** Throws when a value is not a supported gateway. */
export function assertSupportedGateway(value: unknown): SupportedGateway {
  if (!isSupportedGateway(value)) {
    throw new Error(
      `Unsupported payment gateway "${String(value)}" — Genhub settles every payment through ${SUPPORTED_GATEWAYS[0]}.`
    );
  }
  return value;
}

/**
 * Throws when an unexpected provider reaches settlement. Local development may
 * still use the SANDBOX marker; production may not.
 */
export function assertSupportedSettlementProvider(
  provider: unknown,
  options?: { allowSandbox?: boolean }
): string {
  const allowSandbox = options?.allowSandbox ?? process.env.NODE_ENV !== "production";
  if (provider === "SANDBOX" && allowSandbox) return "SANDBOX";

  if (!isSupportedSettlementProvider(provider) || provider === "SANDBOX") {
    throw new Error(
      `Unsupported payment provider "${String(provider)}" reached settlement — only ${SUPPORTED_GATEWAYS[0]} is allowed.`
    );
  }
  return provider as string;
}
