#!/usr/bin/env node
// =============================================================================
// GENHUB - Gateway lock (build-time guard)
// Run:  node scripts/verify-gateway.mjs   (also wired as `prebuild`)
//
// HarakaPay is the only payment gateway. Exits 1 the moment a second gateway
// reappears in the Prisma enum, in src/lib/payments, or anywhere in shipped
// source — so a legacy integration can never slip back in unnoticed.
// =============================================================================

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { ok, fail } from "./_env.mjs";

const ROOT = process.cwd();
const DECOMMISSIONED = ["AZAMPAY", "SELCOM"];
let failures = 0;

const check = (pass, passMsg, failMsg) => {
  if (pass) ok(passMsg);
  else {
    fail(failMsg);
    failures++;
  }
};

function walk(dir, extensions) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      out.push(...walk(full, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

console.log("\n=== GENHUB GATEWAY LOCK ===\n");

// 1) Prisma enum
const schemaPath = join(ROOT, "prisma", "schema.prisma");
const schema = existsSync(schemaPath) ? readFileSync(schemaPath, "utf8") : "";
const block = schema.match(/enum\s+PaymentGateway\s*\{([^}]*)\}/);
const enumValues = block
  ? block[1]
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "").trim())
      .filter(Boolean)
  : [];

check(
  JSON.stringify(enumValues) === JSON.stringify(["HARAKAPAY"]),
  "Prisma PaymentGateway enum contains HARAKAPAY only",
  `Prisma PaymentGateway enum is [${enumValues.join(", ") || "not found"}] — expected [HARAKAPAY]`
);

// 2) Integration modules
const paymentsDir = join(ROOT, "src", "lib", "payments");
const modules = existsSync(paymentsDir)
  ? readdirSync(paymentsDir)
      .filter((f) => f.endsWith(".ts"))
      .sort()
  : [];

check(
  JSON.stringify(modules) === JSON.stringify(["gateway.ts", "harakapay.ts"]),
  "src/lib/payments holds gateway.ts + harakapay.ts only",
  `src/lib/payments holds [${modules.join(", ") || "nothing"}] — expected [gateway.ts, harakapay.ts]`
);

// 3) No reference to a decommissioned gateway in shipped source
const offenders = [];
for (const file of walk(join(ROOT, "src"), [".ts", ".tsx"])) {
  if (file.endsWith(".test.ts")) continue; // tests assert they are rejected
  const upper = readFileSync(file, "utf8").toUpperCase();
  for (const id of DECOMMISSIONED) {
    if (upper.includes(id)) offenders.push(`${relative(ROOT, file)} → ${id}`);
  }
}

check(
  offenders.length === 0,
  "No shipped source references a decommissioned gateway",
  `Decommissioned gateway reference(s) found:\n      ${offenders.join("\n      ")}`
);

console.log(`\n=== ${failures === 0 ? "PASS" : `${failures} FAILURE(S)`} ===\n`);
if (failures > 0) {
  console.log("Only HarakaPay may process payments. Remove the gateway above.\n");
  process.exit(1);
}
