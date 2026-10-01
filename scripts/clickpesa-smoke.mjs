#!/usr/bin/env node
// =============================================================================
// GENHUB - ClickPesa live smoke test
// Run:  node scripts/clickpesa-smoke.mjs
//         -> READ-ONLY: mint an authorization token (proves the client id +
//            api key work, moves no money) and report the webhook secret state
//       node scripts/clickpesa-smoke.mjs --collect 1000 0712345678
//         -> REAL USSD push of TZS 1000 to your phone (confirm it on the
//            handset, then check the transaction settled via webhook/status)
//
// Uses CLICKPESA_CLIENT_ID / CLICKPESA_API_KEY / CLICKPESA_BASE_URL from
// .env.local. Exits non-zero on any failure so it can gate CI.
// =============================================================================

import { loadEnv, ok, warn, fail } from "./_env.mjs";

loadEnv();

const clientId = (process.env.CLICKPESA_CLIENT_ID || "").trim();
const apiKey = (process.env.CLICKPESA_API_KEY || "").trim();
const base = (process.env.CLICKPESA_BASE_URL || "https://api.clickpesa.com/third-parties").replace(
  /\/+$/,
  ""
);
const args = process.argv.slice(2);

if (!clientId || !apiKey) {
  fail("CLICKPESA_CLIENT_ID / CLICKPESA_API_KEY are not set in .env.local");
  process.exit(1);
}

/** A reference the gateway accepts: alphanumeric, at most 20 characters. */
function orderReference(prefix) {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}${stamp}${random}`.replace(/[^A-Za-z0-9]/g, "").slice(0, 20);
}

/** Normalize to the MSISDN format ClickPesa wants: 255712345678. */
function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("255")) return digits;
  if (digits.startsWith("0")) return `255${digits.slice(1)}`;
  return digits;
}

/** Mint an authorization token. Read-only. */
async function token() {
  const res = await fetch(`${base}/generate-token`, {
    method: "POST",
    headers: { "client-id": clientId, "api-key": apiKey },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) {
    fail(`generate-token -> HTTP ${res.status}: ${body?.message || res.statusText}`);
    if (res.status === 401 || res.status === 403) {
      console.log("   The credentials are invalid or revoked — check your ClickPesa dashboard.");
    }
    process.exit(1);
  }
  return body.token; // already prefixed with "Bearer "
}

async function authed(path, init = {}) {
  const bearer = await token();
  const res = await fetch(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(20_000),
    headers: {
      "Content-Type": "application/json",
      Authorization: bearer,
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

console.log(`\n=== ClickPesa smoke test — ${base} ===\n`);

// 1) Read-only credential check
const bearer = await token();
ok(`credentials valid — authorization token issued (${bearer.slice(0, 14)}…)`);
if (!process.env.CLICKPESA_CHECKSUM_KEY && !process.env.CLICKPESA_WEBHOOK_TOKEN) {
  warn(
    "no webhook verification secret set (CLICKPESA_CHECKSUM_KEY / CLICKPESA_WEBHOOK_TOKEN) — " +
      "callbacks would be accepted without proof they came from ClickPesa"
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
    const { res, body } = await authed("/payments/initiate-ussd-push-request", {
      method: "POST",
      body: JSON.stringify({
        amount: String(amount),
        currency: "TZS",
        orderReference: reference,
        phoneNumber: phone,
      }),
    });
    console.log(JSON.stringify(body, null, 2));
    if (res.ok && (body.orderReference || body.id)) {
      ok(`collect accepted — orderReference=${body.orderReference || reference}`);
      console.log(
        "   Next: confirm on the phone, then verify the webhook hit /api/webhooks/clickpesa and the transaction flipped to SUCCESS."
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
  "\nNote: live checkout requires PAYMENT_SANDBOX=false and the webhook configured in the ClickPesa dashboard.\n"
);
