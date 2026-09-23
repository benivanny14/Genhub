"use client";

// =============================================================================
// GENHUB - Currency provider (display-only TZS/USD toggle)
// Payments always settle in TZS; USD is a convenience conversion.
// =============================================================================

import { createContext, useContext, useState, useEffect } from "react";

export type Currency = "TZS" | "USD";

// Static display rate — payments, payouts and wallet debits stay in TZS.
export const TZS_PER_USD = 2650;

interface CurrencyContextValue {
  currency: Currency;
  toggleCurrency: () => void;
  /** Formats a TZS amount in the active display currency */
  format: (tzs: number) => string;
}

const CurrencyContext = createContext<CurrencyContextValue | null>(null);

const STORAGE_KEY = "genhub_currency";

export function CurrencyProvider({ children }: { children: React.ReactNode }) {
  const [currency, setCurrency] = useState<Currency>("TZS");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "USD" || saved === "TZS") setCurrency(saved);
    } catch {}
  }, []);

  function toggleCurrency() {
    setCurrency((prev) => {
      const next = prev === "TZS" ? "USD" : "TZS";
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {}
      return next;
    });
  }

  function format(tzs: number): string {
    if (currency === "USD") {
      const usd = tzs / TZS_PER_USD;
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(usd);
    }
    return new Intl.NumberFormat("en-TZ", {
      style: "currency",
      currency: "TZS",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(tzs);
  }

  return (
    <CurrencyContext.Provider value={{ currency, toggleCurrency, format }}>
      {children}
    </CurrencyContext.Provider>
  );
}

export function useCurrency(): CurrencyContextValue {
  const ctx = useContext(CurrencyContext);
  if (!ctx) {
    // Graceful fallback so components outside the provider still render
    return {
      currency: "TZS",
      toggleCurrency: () => {},
      format: (tzs: number) =>
        new Intl.NumberFormat("en-TZ", {
          style: "currency",
          currency: "TZS",
          minimumFractionDigits: 0,
          maximumFractionDigits: 0,
        }).format(tzs),
    };
  }
  return ctx;
}
