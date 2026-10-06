#!/usr/bin/env node
// =============================================================================
// GENHUB - SonicPesa live smoke test
// Run:  node scripts/sonicpesa-smoke.mjs
//         -> READ-ONLY: list transactions (proves the access key works, moves
//            no money) and report the webhook secret state
//       node scripts/sonicpesa-smoke.mjs --collect 1000 0712345678
//         -> REAL USSD push of TZS 1000 to your phone (confirm it on the
//            handset, then check the transaction settled via webhook/status)
//
// Uses SONICPESA_ACCESS_KEY / SONICPESA_SECRET_KEY / SONICPESA_BASE_URL from
// .env.local. Exits non-zero on any failure so it can gate CI.
// =============================================================================

import { loadEnv, ok, warn, fail } from "./_env.mjs";

loadEnv();

const accessKey = (process.env.SONICPESA_ACCESS_KEY || "").trim();
const base = (process.env.SONICPESA_BASE_URL || "https://api.sonicpesa.com/api/v1").replace(
  /\/+$/,
  ""
);
const args = process.argv.slice(2);

if (!accessKey) {
  fail("SONICPESA_ACCESS_KEY is not set in .env.local");
  process.exit(1);
}

/** A trace reference of our own (SonicPesa assigns the real order id). */
function orderReference(prefix) {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}${stamp}${random}`.replace(/[^A-Za-z0-9]/g, "").slice(0, 20);
}

/** Normalize to the MSISDN format SonicPesa wants: 255712345678. */
function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("255")) return digits;
  if (digits.startsWith("0")) return `255${digits.slice(1)}`;
  return digits;
}

/** One authenticated, bounded call. Auth is the static X-API-KEY header. */
async function call(path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": accessKey,
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

console.log(`\n=== SonicPesa smoke test — ${base} ===\n`);

// 1) Read-only credential check
const probe = await call("/transactions/readbyId", {
  method: "POST",
  body: JSON.stringify({ page: 1 }),
});
if (!probe.res.ok) {
  fail(`transactions/readbyId -> HTTP ${probe.res.status}: ${probe.body?.message || probe.res.statusText}`);
  if (probe.res.status === 401 || probe.res.status === 403) {
    console.log("   The access key is invalid or revoked — check your SonicPesa dashboard.");
  }
  process.exit(1);
}
ok("access key accepted — transactions endpoint answered");

if (!process.env.SONICPESA_SECRET_KEY && !process.env.SONICPESA_WEBHOOK_TOKEN) {
  warn(
    "no webhook verification secret set (SONICPESA_SECRET_KEY / SONICPESA_WEBHOOK_TOKEN) — " +
      "callbacks would be accepted without proof they came from SonicPesa"
  );
}

// 2) Optional: real USSD push (money moves!)
const collectIdx = args.indexOf("--collect");
if (collectIdx !== -1) {
  const amount = Number(args[collectIdx + 1]);
  const phone = normalizePhone(args[collectIdx + 2]);
  if (!amount || !phone) {
    fail("usage: --collect <amountTZS> <07XXXXXXXX>");
    process.exit(1);
  }
  const reference = orderReference("SMOKE");
  warn(`sending a REAL USSD push: TZS ${amount} to ${phone} — confirm on the handset`);
  try {
    const { res, body } = await call("/payment/create_order", {
      method: "POST",
      body: JSON.stringify({
        buyer_email: process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "payments@genhub.app",
        buyer_name: "Genhub smoke test",
        buyer_phone: phone,
        amount,
        currency: "TZS",
      }),
    });
    console.log(JSON.stringify(body, null, 2));
    const orderId = body?.data?.order_id;
    if (res.ok && orderId) {
      ok(`collect accepted — order_id=${orderId} (our trace ref ${reference})`);
      console.log(
        "   Next: confirm on the phone, then verify the webhook hit /api/webhooks/sonicpesa and the transaction flipped to SUCCESS."
      );
    } else {
      fail(`collect rejected: ${body.message || res.statusText}`);
      process.exit(1);
    }
  } catch (error) {
    fail(`collect failed: ${error.message || error}`);
    process.exit(1);
  }
} else {
  console.log("   Read-only mode. Add --collect <amount> <phone> for a real USSD push.");
}

console.log(
  "\nNote: live checkout requires PAYMENT_SANDBOX=false and the webhook configured in the SonicPesa dashboard.\n"
);
