// =============================================================================
// GENHUB - One-command environment setup
//
// Run:  npm run setup
//
//   1. Creates .env.local from the template if it is missing.
//   2. Generates only the secrets that are MISSING OR UNFIT, judged by the same
//      `assessSecret` rule preflight and verify:live use, so the three scripts
//      can never disagree about what "good enough to sign tokens" means.
//   3. Never rewrites a value that already passes. Rewriting a live CRON_SECRET
//      would silently break the scheduler, and rewriting
//      HARAKAPAY_WEBHOOK_TOKEN would break the token registered in the
//      webhook_url - so values that pass are left byte-identical.
//   4. Backs the file up before writing.
//   5. Opens the file and prints only what is left to collect, with the exact
//      site and click path for each one.
//
// The checklist lives in src/lib/setup-checklist.json, which the admin Setup tab
// reads too. That is deliberate: when each kept its own copy they could tell you
// different things about the same variable, and both sounded equally confident.
//
// No script can log into Bunny or HarakaPay for you. This removes the part that
// does not need a human, and nothing more.
// =============================================================================

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { loadEnv, assessSecret } from "./_env.mjs";

const ROOT = process.cwd();
const EXAMPLE = resolve(ROOT, ".env.example");
const TARGET = resolve(ROOT, ".env.local");
const BACKUP = resolve(ROOT, ".env.local.backup");
const CHECKLIST_FILE = resolve(ROOT, "src/lib/setup-checklist.json");

const GENERATE = [
  { key: "JWT_SECRET", bytes: 32 },
  { key: "CRON_SECRET", bytes: 32 },
  { key: "HARAKAPAY_WEBHOOK_TOKEN", bytes: 24 },
];

const CHECKLIST_DATA = JSON.parse(readFileSync(CHECKLIST_FILE, "utf8"));
const CHECKLIST = CHECKLIST_DATA.groups;

// Same rules the admin Setup tab compiles, from the same file. See the
// $rulesComment in setup-checklist.json for why this is not written twice.
const PLACEHOLDER_PATTERN = new RegExp(CHECKLIST_DATA.rules.placeholder, "i");
const LOCAL_PATTERN = new RegExp(CHECKLIST_DATA.rules.local, "i");

// --- 1. make sure the file exists -------------------------------------------
let created = false;
if (!existsSync(TARGET)) {
  if (!existsSync(EXAMPLE)) {
    console.error("\n  .env.example is missing - are you in the project root?\n");
    process.exit(1);
  }
  copyFileSync(EXAMPLE, TARGET);
  created = true;
}

// --- 2. generate ONLY what is missing or unfit ------------------------------
// loadEnv() parses exactly like the app does (quotes and inline comments
// stripped), and assessSecret() is the same rule the other scripts use.
loadEnv();

let text = readFileSync(TARGET, "utf8");
const generated = [];
const kept = [];

for (const { key, bytes } of GENERATE) {
  const current = process.env[key] || "";
  const verdict = assessSecret(current);
  if (verdict.ok) {
    kept.push(key);
    continue;
  }
  const secret = randomBytes(bytes).toString("hex");
  const line = new RegExp("^\\s*" + key + "\\s*=.*$", "m");
  text = line.test(text)
    ? text.replace(line, `${key}=${secret}`)
    : text.replace(/\n*$/, "") + `\n${key}=${secret}\n`;
  process.env[key] = secret;
  generated.push({ key, reason: verdict.reason });
}

// --- 3. back up, then write -------------------------------------------------
if (generated.length) {
  copyFileSync(TARGET, BACKUP);
  writeFileSync(TARGET, text.endsWith("\n") ? text : text + "\n");
}

const values = new Map();
for (const line of readFileSync(TARGET, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) {
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    } else {
      const hash = v.search(/(^|\s)#/);
      if (hash !== -1) v = v.slice(0, hash).trim();
    }
    values.set(m[1], v);
  }
}

// Mirrors classifyValue in src/lib/setup-check.ts, including the ORDER, because
// order is what decides which diagnosis an operator is given: a value like
// http://localhost:3000 fails the must-contain-https rule too, and reporting the
// scheme instead of "this still points at your laptop" sends them to the wrong
// problem. Both sides read the patterns from setup-checklist.json.
const status = (item) => {
  if (!item.key) return "money";
  const v = (values.get(item.key) || "").trim();
  if (!v) return "NOT SET";
  if (item.forbid && v.includes(item.forbid)) return "wrong format";
  if (PLACEHOLDER_PATTERN.test(v)) return "placeholder";
  if (LOCAL_PATTERN.test(v)) return "still local";
  if (item.must && !v.includes(item.must)) return "wrong format";
  if (item.key === "NEXT_PUBLIC_APP_URL" && !/^https:\/\//.test(v)) return "wrong format";
  return "done";
};

// --- 4. report --------------------------------------------------------------
console.log("\n" + "=".repeat(74));
console.log("  GENHUB - ENVIRONMENT SETUP");
console.log("=".repeat(74));

if (created) console.log("\n  Created .env.local from .env.example");
if (generated.length) {
  console.log("\n  Secrets generated (not printed here, on purpose):");
  for (const g of generated) {
    console.log(`    ${g.key.padEnd(26)} (${g.reason})`);
  }
  console.log("  Backup written to .env.local.backup");
}
if (kept.length) {
  console.log("\n  Secrets already present AND fit - LEFT UNTOUCHED:");
  for (const k of kept) console.log(`    ${k}`);
  console.log("  (rotating CRON_SECRET breaks the scheduler; rotating");
  console.log("   HARAKAPAY_WEBHOOK_TOKEN breaks the registered webhook)");
}

let done = 0;
let todo = 0;
for (const group of CHECKLIST) {
  const pending = group.items.filter((it) => status(it) !== "done");
  done += group.items.length - pending.length;
  if (!pending.length) {
    console.log(`\n  [done] ${group.title} - complete`);
    continue;
  }
  todo += pending.length;
  console.log(`\n${group.title.toUpperCase()}   (${group.cost} - ${group.time})`);

  for (const it of pending) {
    console.log(`\n   ${it.title}   [${status(it)}]`);
    if (it.key) console.log(`      Variable:  ${it.key}`);
    console.log(`      Get it at: ${it.site}`);
    for (const s of it.steps) console.log(`        - ${s}`);
    if (it.example) console.log(`      Write this:  ${it.example}`);
    if (it.must) console.log(`      MUST contain: ${it.must}`);
    if (it.forbid) console.log(`      MUST NOT contain: ${it.forbid}`);
  }
}

console.log("\n" + "-".repeat(74));
console.log(`  Collected: ${done}      Still to do: ${todo}`);
console.log("-".repeat(74));
console.log("\nYour next steps:");
console.log("  1. Fill in everything shown above inside .env.local (opening now)");
console.log("  2. Save it: Ctrl+S, then close");
console.log("  3. Run:  npm run verify:live        (proves each value works)");
console.log("  4. When finished:  npm run preflight:prod    (must say 0 blockers)");
console.log("\nChanged .env.local? RESTART the server: Ctrl+C then npm run dev");
console.log("\nThe same checklist, with status and live checks, is in the website:");
console.log("  Admin panel -> Setup tab");
console.log("Full step-by-step guide: SETUP.md");
console.log("-".repeat(74) + "\n");

// --- 5. open it for them ----------------------------------------------------
if (process.env.SETUP_NO_OPEN !== "1") {
  const win = process.platform === "win32";
  const bin = win ? "C:\\Windows\\System32\\notepad.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(bin, [TARGET], { detached: true, stdio: "ignore" });
    child.unref();
    console.log("Opened .env.local - fill it in and save.\n");
  } catch {
    console.log(`Open it yourself:  notepad "${TARGET}"\n`);
  }
}
