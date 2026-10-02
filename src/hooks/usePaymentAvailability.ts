"use client";

// =============================================================================
// GENHUB - Is mobile money reachable right now?
//
// Reads the public /api/payments/availability endpoint so a money screen can
// disable its Pay button and say why, instead of letting a customer click into a
// generic error. `null` means "not known yet" — callers must keep the button
// ENABLED while it is null, because a network hiccup reading this must never be
// the thing that blocks a real payment.
// =============================================================================

import { useEffect, useState } from "react";

export interface PaymentAvailability {
  available: boolean;
  reason: "ok" | "sandbox" | "gateway-unreachable" | "not-configured";
  breakerOpen: boolean;
  breakerOpenUntil: string | null;
  sandbox: boolean;
  checkedAt: string;
}

export function usePaymentAvailability(): {
  availability: PaymentAvailability | null;
  loading: boolean;
} {
  const [availability, setAvailability] = useState<PaymentAvailability | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/payments/availability");
        const data = await res.json();
        if (!cancelled && data?.success) setAvailability(data.data as PaymentAvailability);
      } catch {
        // Unknown on failure: leave `availability` null so the caller keeps the
        // button enabled rather than disabling payments over a bad read.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return { availability, loading };
}

/**
 * The sentence to show a customer when payments are not available.
 *
 * One place, so the paywall and the wallet cannot describe the same outage two
 * ways. A "not configured" deployment is an operator problem, not the
 * customer's, so it reads as a temporary outage too.
 */
export function paymentUnavailableMessage(
  reason: PaymentAvailability["reason"]
): string {
  switch (reason) {
    case "gateway-unreachable":
      return "Mobile money is temporarily unavailable. Nothing has been charged — please try again in a few minutes.";
    case "not-configured":
      return "Mobile money is temporarily unavailable. Wallet payments still work if you have a balance.";
    default:
      return "Mobile money is temporarily unavailable. Please try again in a few minutes.";
  }
}
