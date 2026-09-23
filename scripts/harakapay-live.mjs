#!/usr/bin/env node
// =============================================================================
// GENHUB - LIVE HarakaPay smoke test (real USSD push to your phone)
// Usage:
//   node scripts/harakapay-live.mjs 0712345678 1000
//   npm run smoke:harakapay:live -- 0712345678 1000
//
// WHAT IT DOES
//   1. Reads HARAKAPAY_API_KEY + app URL from .env.local
//   2. Creates a real "collect" order for <amount> TZS to your phone
//   3. Prints the checkout URL (open it if no USSD push arrives)
//   4. Polls status until COMPLETED / FAILED / timeout (90s)
//
// PREREQUISITES (one-time, in the HarakaPay dashboard)
//   * PAYMENT_SANDBOX=false in .env.local
//   * webhook_url registered:  https://<your-domain>/api/webhooks/harakapay
//   * your phone can receive USSD push (Vodacom/Tigo/Airtel)
//
// SAFETY
//   * Starts at the MINIMUM amount (default 1000 TZS = 1,000) so a mistake
//     costs as little as possible. Cancel on your phone to pay nothing.
//   * Read-only after order creation: never touches the Genhub database.
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
  console.error("Usage: node scripts/harakapay-live.mjs <phone> [amount=1000]");
  console.error("  e.g. node scripts/harakapay-live.mjs 0712345678 1000");
  process.exit(1);
}
if (!env.HARAKAPAY_API_KEY) {
  console.error("✗ HARAKAPAY_API_KEY missing in .env.local");
  process.exit(1);
}
if (env.PAYMENT_SANDBOX === "true") {
  console.error("✗ PAYMENT_SANDBOX=true — switch to false for a LIVE run:");
  console.error("    PAYMENT_SANDBOX=false   in .env.local, then restart the server.");
  process.exit(1);
}

const API = (env.HARAKAPAY_API_URL || "https://api.harakapay.net").replace(/\/$/, "");
const norm = phone.startsWith("255") ? phone : "255" + phone.replace(/^0/, "");

async function call(path, body) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": env.HARAKAPAY_API_KEY,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

(async () => {
  console.log("== HarakaPay LIVE smoke test ==");
  console.log(`   api:     ${API}`);
  console.log(`   phone:   ${norm}`);
  console.log(`   amount:  ${amount} TZS (real money — cancel on the phone to abort)`);
  console.log(`   webhook: ${env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/webhooks/harakapay`);
  console.log("");

  // 1. balance probe (read-only sanity check of the key)
  const bal = await call("/api/v1/wallet", {}).catch(() => null);
  if (bal) console.log(`   key probe: HTTP ${bal.status}${bal.json?.wallet_balance != null ? ` · wallet=${bal.json.wallet_balance} TZS` : ""}`);

  // 2. create a real collect order
  const created = await call("/api/v1/collect", {
    amount,
    phone: norm,
    currency: "TZS",
    description: "Genhub live smoke test",
    webhook_url: `${(env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "")}/api/webhooks/harakapay`,
  });

  console.log(`\n   create:  HTTP ${created.status}`);
  const orderId = created.json?.order_id || created.json?.id;
  const checkout = created.json?.checkout_url || created.json?.redirect_url;
  if (!orderId) {
    console.error("   ✗ no order_id in response:");
    console.error("   " + JSON.stringify(created.json, null, 2).slice(0, 800));
    process.exit(1);
  }
  console.log(`   order:   ${orderId}`);
  if (checkout) console.log(`   checkout: ${checkout}   ← open this if no USSD push appears`);
  console.log("\n   → CHECK YOUR PHONE and confirm with your PIN…");

  // 3. poll
  for (let i = 1; i <= 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await call(`/api/v1/collect/${orderId}`, {}).catch(() => null);
    const status = st?.json?.status || st?.json?.data?.status || "?";
    process.stdout.write(`   [${String(i).padStart(2)}] status=${status}\n`);
    const s = String(status).toUpperCase();
    if (["COMPLETED", "SUCCESS", "PAID"].includes(s)) {
      console.log("\n✓ LIVE payment completed — gateway reachable, webhook will fire to /api/webhooks/harakapay");
      process.exit(0);
    }
    if (["FAILED", "CANCELLED", "EXPIRED", "DECLINED"].includes(s)) {
      console.log("\n✗ payment not completed: " + JSON.stringify(st?.json).slice(0, 400));
      process.exit(1);
    }
  }
  console.log("\n… timed out after 90s (order still pending). Check the dashboard or your phone.");
  process.exit(2);
})().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
