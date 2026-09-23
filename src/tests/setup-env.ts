// =============================================================================
// GENHUB - Vitest env setup
// Next.js loads .env.local automatically; plain vitest does not. This setup
// file parses .env.local into process.env BEFORE test files import config /
// prisma, so integration tests see DATABASE_URL, gateway keys, etc.
// Never overrides variables that are already set (NODE_ENV=test stays "test").
// =============================================================================

import fs from "node:fs";
import path from "node:path";

const envPath = path.resolve(process.cwd(), ".env.local");

if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// Safety rail: the E2E suite must NEVER hit a real payment gateway, even when
// .env.local has PAYMENT_SANDBOX=false for manual live testing. Tests always
// run through the sandbox completion endpoint.
process.env.PAYMENT_SANDBOX = "true";
