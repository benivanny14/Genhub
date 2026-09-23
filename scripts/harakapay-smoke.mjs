#!/usr/bin/env node
// =============================================================================
// GENHUB - HarakaPay live smoke test
// Run:  node scripts/harakapay-smoke.mjs
//         -> READ-ONLY GET /api/v1/balance (proves the API key works, moves
//            no money)
//       node scripts/harakapay-smoke.mjs --collect 1000 0712345678
//         -> REAL USSD push of TZS 1000 to your phone (confirm it on the
//            handset, then check the transaction landed via webhook/status)
//
// Uses HARAKAPAY_API_KEY / HARAKAPAY_BASE_URL from .env.local.
// =============================================================================

import { loadEnv, ok, warn, fail } from "./_env.mjs";

loadEnv();

const key = (process.env.HARAKAPAY_API_KEY || "").trim();
const base = (process.env.HARAKAPAY_BASE_URL || "https://harakapay.net").replace(
  /\/+$/,
  ""
);
const args = process.argv.slice(2);

if (!key) {
  fail("HARAKAPAY_API_KEY is not set in .env.local");
  process.exit(1);
}

async function hp(path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(20_000),
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": key,
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

console.log(`\n=== HarakaPay smoke test — ${base} ===\n`);

// 1) Read-only credential check
try {
  const { res, body } = await hp("/api/v1/balance");
  if (!res.ok) {
    fail(`GET /api/v1/balance -> HTTP ${res.status}: ${body?.error || res.statusText}`);
    if (res.status === 401 || res.status === 403) {
      console.log("   The API key is invalid or revoked — regenerate it in the HarakaPay dashboard.");
    }
    process.exit(1);
  }
  ok(
    `credentials valid — wallet_balance=${body.wallet_balance ?? "?"} TZS, float_balance=${body.float_balance ?? "?"} TZS`
  );
} catch (error) {
  fail(`could not reach HarakaPay: ${error.message || error}`);
  console.log("   Check network access and HARAKAPAY_BASE_URL.");
  process.exit(1);
}

// 2) Optional: real USSD push (money moves!)
const collectIdx = args.indexOf("--collect");
if (collectIdx !== -1) {
  const amount = Number(args[collectIdx + 1]);
  const phone = args[collectIdx + 2];
  if (!amount || !phone) {
    fail("usage: --collect <amountTZS> <07XXXXXXXX>");
    process.exit(1);
  }
  warn(`sending a REAL USSD push: TZS ${amount} to ${phone} — confirm on the handset`);
  try {
    const { res, body } = await hp("/api/v1/collect", {
      method: "POST",
      body: JSON.stringify({
        phone,
        amount,
        description: "Genhub smoke test",
      }),
    });
    console.log(JSON.stringify(body, null, 2));
    if (res.ok && body.success !== false) {
      ok(`collect accepted — order_id=${body.order_id || "(see payload)"}`);
      console.log(
        "   Next: confirm on the phone, then verify the webhook hit /api/webhooks/harakapay and the transaction flipped to SUCCESS."
      );
    } else {
      fail(`collect rejected: ${body.error || res.statusText}`);
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
  "\nNote: live checkout requires PAYMENT_SANDBOX=false and a registered webhook URL.\n"
);
