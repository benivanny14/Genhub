// =============================================================================
// GENHUB - Payment gateway lock
// ClickPesa is the ONLY payment gateway. Every payment entry point and the
// settlement choke point import from here, so a legacy gateway can never be
// wired back in silently: an unexpected value fails loudly instead of quietly
// routing money somewhere else.
//
// A retired gateway is still named in the Prisma enum because the transactions
// it processed are real history — dropping the value would make those rows
// unreadable. It is deliberately NOT in `SUPPORTED_GATEWAYS` or
// `SETTLEMENT_PROVIDERS`, so it can never settle a new payment: it is a label
// for the past, not a route for money.
//
// The adapter registry below is the single seam through which a caller reaches
// a gateway. Cross-cutting code (routes, services) can depend on this module —
// not on the integration file — so adding a future gateway means registering an
// adapter here, without editing every caller. Today CLICKPESA is the only
// registered adapter, and the guard test in src/tests/gateway-guard.test.ts
// keeps it that way.
// =============================================================================

import config from "../config";
import {
  clickpesaCollect,
  clickpesaStatus,
  clickpesaGatewayState,
  type ClickPesaCollectResponse,
  type ClickPesaStatusResponse,
} from "./clickpesa";

export const SUPPORTED_GATEWAYS = ["CLICKPESA"] as const;
export type SupportedGateway = (typeof SUPPORTED_GATEWAYS)[number];

/**
 * `provider` labels allowed to reach settlement. ClickPesa is the only real
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

// =============================================================================
// Gateway adapter registry
//
// A gateway-agnostic view of what every caller needs: whether it is configured,
// its circuit-breaker state, and the two operations that move a charge (collect,
// status). The shapes are neutral on purpose — nothing here is named after a
// vendor — so the rest of the app can stay unaware of which gateway is behind it.
// =============================================================================

/** A charge request, expressed the same way for every gateway. */
export interface GatewayCollectRequest {
  /** Normalized MSISDN, e.g. 255712345678 (no +, no leading 0). */
  phone: string;
  /** Amount in the gateway's settlement currency (TZS). */
  amount: number;
  /** Unique, alphanumeric order reference the gateway echoes back. */
  orderReference: string;
}

/** The gateway's circuit-breaker snapshot, for diagnostics and health pages. */
export interface GatewayBreakerState {
  open: boolean;
  openUntil: number;
  failures: number;
  skipped: number;
}

/** Everything a caller may ask of a gateway, without naming it. */
export interface PaymentGatewayAdapter {
  readonly id: SupportedGateway;
  /** Credentials are present, so a live charge could even be attempted. */
  isConfigured(): boolean;
  /** The local breaker: true while gateway calls are being skipped. */
  breakerState(): GatewayBreakerState;
  /** Send the mobile-money prompt. */
  collect(request: GatewayCollectRequest): Promise<ClickPesaCollectResponse>;
  /** Ask the gateway for the current verdict on an order reference. */
  status(orderReference: string): Promise<ClickPesaStatusResponse>;
}

/**
 * The ClickPesa adapter. It is the only registered gateway, and it exists so
 * callers depend on `PaymentGatewayAdapter` rather than on the integration file.
 */
const clickPesaAdapter: PaymentGatewayAdapter = {
  id: "CLICKPESA",
  isConfigured: () => Boolean(config.clickPesa.clientId && config.clickPesa.apiKey),
  breakerState: () => clickpesaGatewayState(),
  collect: (request) => clickpesaCollect(request),
  status: (orderReference) => clickpesaStatus(orderReference),
};

/** Every supported gateway id, mapped to its adapter. One entry today. */
export const PAYMENT_GATEWAYS: Readonly<Record<SupportedGateway, PaymentGatewayAdapter>> = {
  CLICKPESA: clickPesaAdapter,
};

/**
 * Resolve an adapter by id, refusing anything unsupported. This is the entry
 * point cross-cutting code should use instead of importing an integration file.
 */
export function resolvePaymentGateway(id: unknown): PaymentGatewayAdapter {
  const supported = assertSupportedGateway(id);
  return PAYMENT_GATEWAYS[supported];
}
