// =============================================================================
// GENHUB - Payment gateway lock (guard test)
//
// HarakaPay is the only gateway. This suite fails the build if a second
// gateway is ever wired back in — whether through the Prisma enum, a new
// integration module, an import of a deleted module, or a stray identifier in
// the source tree.
// =============================================================================

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  SUPPORTED_GATEWAYS,
  assertSupportedGateway,
  assertSupportedSettlementProvider,
} from "@/lib/payments/gateway";
import { initiatePaymentSchema, topUpWalletSchema } from "@/lib/validation";

const ROOT = process.cwd();

/** Gateway ids that must never appear in shipped source again. */
const DECOMMISSIONED = ["AZAMPAY", "SELCOM"];

function walk(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      out.push(...walk(full, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

describe("payment gateway lock", () => {
  it("supports HarakaPay and nothing else", () => {
    expect(SUPPORTED_GATEWAYS).toEqual(["HARAKAPAY"]);
  });

  it("declares only HARAKAPAY in the Prisma PaymentGateway enum", () => {
    const schema = fs.readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf8");
    const block = schema.match(/enum\s+PaymentGateway\s*\{([^}]*)\}/);
    expect(block, "PaymentGateway enum not found in prisma/schema.prisma").toBeTruthy();

    const values = block![1]
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "").trim())
      .filter(Boolean);

    expect(values).toEqual(["HARAKAPAY"]);
  });

  it("ships only the HarakaPay integration module", () => {
    const files = fs
      .readdirSync(path.join(ROOT, "src", "lib", "payments"))
      .filter((f) => f.endsWith(".ts"))
      .sort();

    expect(files).toEqual(["gateway.ts", "harakapay.ts"]);
  });

  it("has no shipped source reference to a decommissioned gateway", () => {
    const offenders: string[] = [];

    for (const file of walk(path.join(ROOT, "src"), [".ts", ".tsx"])) {
      // Tests are allowed to name them — they assert they are rejected.
      if (file.endsWith(".test.ts")) continue;

      const upper = fs.readFileSync(file, "utf8").toUpperCase();
      for (const id of DECOMMISSIONED) {
        if (upper.includes(id)) offenders.push(`${path.relative(ROOT, file)} → ${id}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("refuses a decommissioned gateway at validation time", () => {
    for (const gateway of DECOMMISSIONED) {
      expect(
        initiatePaymentSchema.safeParse({
          videoId: "video-1",
          gateway,
          phoneNumber: "0712345678",
        }).success
      ).toBe(false);

      expect(
        topUpWalletSchema.safeParse({
          amount: 5000,
          gateway,
          phoneNumber: "0712345678",
        }).success
      ).toBe(false);
    }
  });

  it("throws when an unsupported gateway is asserted", () => {
    expect(() => assertSupportedGateway("AZAMPAY")).toThrow(/Unsupported payment gateway/);
    expect(assertSupportedGateway("HARAKAPAY")).toBe("HARAKAPAY");
  });

  it("blocks an unsupported provider at settlement", () => {
    expect(() =>
      assertSupportedSettlementProvider("SELCOM", { allowSandbox: false })
    ).toThrow(/Unsupported payment provider/);

    expect(assertSupportedSettlementProvider("HARAKAPAY", { allowSandbox: false })).toBe(
      "HARAKAPAY"
    );

    // The dev sandbox marker is allowed locally, never in production.
    expect(assertSupportedSettlementProvider("SANDBOX", { allowSandbox: true })).toBe("SANDBOX");
    expect(() =>
      assertSupportedSettlementProvider("SANDBOX", { allowSandbox: false })
    ).toThrow(/Unsupported payment provider/);
  });
});
