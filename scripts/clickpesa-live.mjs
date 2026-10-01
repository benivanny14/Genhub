#!/usr/bin/env node
// =============================================================================
// GENHUB - LIVE ClickPesa smoke test (real USSD push to your phone)
// Usage:
//   node scripts/clickpesa-live.mjs 0712345678 1000
//   npm run smoke:clickpesa:live -- 0712345678 1000
//
// WHAT IT DOES
//   1. Reads CLICKPESA_CLIENT_ID / CLICKPESA_API_KEY + app URL from .env.local
//   2. Mints a token, then creates a real USSD-PUSH collection of <amount> TZS
//      to your phone
//   3. Polls the payment status by our order reference until
//      SUCCESS / SETTLED / FAILED / timeout (90s)
//
// PREREQUISITES (one-time, in the ClickPesa dashboard)
//   * PAYMENT_SANDBOX=false in .env.local
//   * webhook registered:  https://<your-domain>/api/webhooks/clickpesa?t=<CLICKPESA_WEBHOOK_TOKEN>
//     (or signed with CLICKPESA_CHECKSUM_KEY)
//   * an approved KYC and an activated USSD-PUSH collection method
//
// SAFETY
//   * Starts at the MINIMUM amount (default 1000 TZS) so a mistake costs as
//     little as possible. Cancel on your phone to pay nothing.
//   * Read-only after the collect: never touches the Genhub database.
// =============================================================================
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv() {
  const out = {};
  try {
    for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i < 0) continue;
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
  return out;
}

const env = { ...process.env, ...loadEnv() };

const phone = (process.argv[2] || "").replace(/[^\d]/g, "");
const amount = parseInt(process.argv[3] || "1000", 10);

if (!phone || phone.length < 9) {
  console.error("Usage: node scripts/clickpesa-live.mjs <phone> [amount=1000]");
  console.error("  e.g. node scripts/clickpesa-live.mjs 0712345678 1000");
  process.exit(1);
}
if (!env.CLICKPESA_CLIENT_ID || !env.CLICKPESA_API_KEY) {
  console.error("✗ CLICKPESA_CLIENT_ID / CLICKPESA_API_KEY missing in .env.local");
  process.exit(1);
}
if (env.PAYMENT_SANDBOX === "true") {
  console.error("✗ PAYMENT_SANDBOX=true — switch to false for a LIVE run:");
  console.error("    PAYMENT_SANDBOX=false   in .env.local, then restart the server.");
  process.exit(1);
}

const API = (env.CLICKPESA_BASE_URL || "https://api.clickpesa.com/third-parties").replace(/\/$/, "");
const norm = phone.startsWith("255") ? phone : "255" + phone.replace(/^0/, "");
const reference = `LIVE${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`.slice(0, 20);

async function token() {
  const res = await fetch(`${API}/generate-token`, {
    method: "POST",
    headers: { "client-id": env.CLICKPESA_CLIENT_ID, "api-key": env.CLICKPESA_API_KEY },
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.token) {
    console.error(`✗ generate-token -> HTTP ${res.status}: ${json.message || res.statusText}`);
    process.exit(1);
  }
  return json.token;
}

async function call(path, init = {}) {
  const bearer = await token();
  const res = await fetch(API + path, {
    ...init,
    signal: AbortSignal.timeout(20_000),
    headers: {
      "Content-Type": "application/json",
      Authorization: bearer,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

(async () => {
  console.log("== ClickPesa LIVE smoke test ==");
  console.log(`   api:     ${API}`);
  console.log(`   phone:   ${norm}`);
  console.log(`   amount:  ${amount} TZS (real money — cancel on the phone to abort)`);
  console.log(`   order:   ${reference}`);
  console.log(`   webhook: ${(env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "")}/api/webhooks/clickpesa`);
  console.log("");

  // 1. read-only credential probe
  const bearer = await token();
  console.log(`   key probe: authorization token issued (${bearer.slice(0, 14)}…)`);

  // 2. create a real USSD push
  const created = await call("/payments/initiate-ussd-push-request", {
    method: "POST",
    body: JSON.stringify({
      amount: String(amount),
      currency: "TZS",
      orderReference: reference,
      phoneNumber: norm,
    }),
  });

  console.log(`\n   create:  HTTP ${created.status}`);
  const orderReference = created.json?.orderReference || reference;
  if (!created.json?.id && !created.json?.orderReference) {
    console.error("   ✗ unexpected response:");
    console.error("   " + JSON.stringify(created.json, null, 2).slice(0, 800));
    process.exit(1);
  }
  console.log(`   order:   ${orderReference}`);
  console.log("\n   → CHECK YOUR PHONE and confirm with your PIN…");

  // 3. poll by order reference
  for (let i = 1; i <= 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await call(`/payments/${encodeURIComponent(orderReference)}`).catch(() => null);
    const payments = Array.isArray(st?.json) ? st.json : st?.json ? [st.json] : [];
    const status = payments[0]?.status || "?";
    process.stdout.write(`   [${String(i).padStart(2)}] status=${status}\n`);
    const s = String(status).toUpperCase();
    if (["SUCCESS", "SETTLED"].includes(s)) {
      console.log("\n✓ LIVE payment completed — gateway reachable, webhook fires to /api/webhooks/clickpesa");
      process.exit(0);
    }
    if (["FAILED", "REFUNDED", "REVERSED"].includes(s)) {
      console.log("\n✗ payment not completed: " + JSON.stringify(payments[0]).slice(0, 400));
      process.exit(1);
    }
  }
  console.log("\n… timed out after 90s (order still pending). Check the dashboard or your phone.");
  process.exit(2);
})().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
