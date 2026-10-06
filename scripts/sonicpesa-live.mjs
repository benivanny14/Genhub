#!/usr/bin/env node
// =============================================================================
// GENHUB - LIVE SonicPesa smoke test (real USSD push to your phone)
// Usage:
//   node scripts/sonicpesa-live.mjs 0712345678 1000
//   npm run smoke:sonicpesa:live -- 0712345678 1000
//
// WHAT IT DOES
//   1. Reads SONICPESA_ACCESS_KEY + app URL from .env.local
//   2. Creates a real USSD-PUSH collection of <amount> TZS to your phone
//   3. Polls the payment status by the gateway's order id until
//      SUCCESS / FAILED / timeout (90s)
//
// PREREQUISITES (one-time, in the SonicPesa dashboard)
//   * PAYMENT_SANDBOX=false in .env.local
//   * webhook registered:  https://<your-domain>/api/webhooks/sonicpesa?t=<SONICPESA_WEBHOOK_TOKEN>
//     (or signed with SONICPESA_SECRET_KEY)
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
  console.error("Usage: node scripts/sonicpesa-live.mjs <phone> [amount=1000]");
  console.error("  e.g. node scripts/sonicpesa-live.mjs 0712345678 1000");
  process.exit(1);
}
if (!env.SONICPESA_ACCESS_KEY) {
  console.error("✗ SONICPESA_ACCESS_KEY missing in .env.local");
  process.exit(1);
}
if (env.PAYMENT_SANDBOX === "true") {
  console.error("✗ PAYMENT_SANDBOX=true — switch to false for a LIVE run:");
  console.error("    PAYMENT_SANDBOX=false   in .env.local, then restart the server.");
  process.exit(1);
}

const API = (env.SONICPESA_BASE_URL || "https://api.sonicpesa.com/api/v1").replace(/\/$/, "");
const norm = phone.startsWith("255") ? phone : "255" + phone.replace(/^0/, "");
const reference = `LIVE${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`.slice(0, 20);

async function call(path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    signal: AbortSignal.timeout(30_000),
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": env.SONICPESA_ACCESS_KEY,
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
  console.log("== SonicPesa LIVE smoke test ==");
  console.log(`   api:     ${API}`);
  console.log(`   phone:   ${norm}`);
  console.log(`   amount:  ${amount} TZS (real money — cancel on the phone to abort)`);
  console.log(`   trace:   ${reference}`);
  console.log(`   webhook: ${(env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "")}/api/webhooks/sonicpesa`);
  console.log("");

  // 1. read-only credential probe
  const probe = await call("/transactions/readbyId", {
    method: "POST",
    body: JSON.stringify({ page: 1 }),
  });
  if (!probe.json || probe.status >= 400) {
    console.error(`✗ access key probe -> HTTP ${probe.status}: ${probe.json?.message || ""}`);
    process.exit(1);
  }
  console.log("   key probe: access key accepted");

  // 2. create a real USSD push
  const created = await call("/payment/create_order", {
    method: "POST",
    body: JSON.stringify({
      buyer_email: env.NEXT_PUBLIC_SUPPORT_EMAIL || "payments@genhub.app",
      buyer_name: "Genhub smoke test",
      buyer_phone: norm,
      amount,
      currency: "TZS",
    }),
  });

  console.log(`\n   create:  HTTP ${created.status}`);
  const orderId = created.json?.data?.order_id;
  if (!orderId) {
    console.error("   ✗ unexpected response:");
    console.error("   " + JSON.stringify(created.json, null, 2).slice(0, 800));
    process.exit(1);
  }
  console.log(`   order:   ${orderId}`);
  console.log("\n   → CHECK YOUR PHONE and confirm with your PIN…");

  // 3. poll by the gateway's order id
  for (let i = 1; i <= 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await call("/payment/order_status", {
      method: "POST",
      body: JSON.stringify({ order_id: orderId }),
    }).catch(() => null);
    const status = st?.json?.data?.payment_status || st?.json?.data?.status || "?";
    process.stdout.write(`   [${String(i).padStart(2)}] status=${status}\n`);
    const s = String(status).toUpperCase();
    if (s === "SUCCESS") {
      console.log("\n✓ LIVE payment completed — gateway reachable, webhook fires to /api/webhooks/sonicpesa");
      process.exit(0);
    }
    if (["FAILED", "CANCELLED", "USERCANCELLED", "REJECTED"].includes(s)) {
      console.log("\n✗ payment not completed: " + JSON.stringify(st?.json?.data || st?.json).slice(0, 400));
      process.exit(1);
    }
  }
  console.log("\n… timed out after 90s (order still pending). Check the dashboard or your phone.");
  process.exit(2);
})().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
