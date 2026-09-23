#!/usr/bin/env node
// =============================================================================
// GENHUB - Endpoint audit: UI fetch() calls vs API routes on disk
// Run:  node scripts/audit-endpoints.mjs   (or: npm run audit:endpoints)
//
// Every fetch("/api/...") in the UI must resolve to an existing route file
// that also exports the HTTP method being used. This class of bug is silent
// in development because optimistic UI hides the 404/405 (it bit us three
// times: /api/videos/report, POST /api/favorites, /api/comments/[id]/report).
//
// Exits 1 when any call site has no route or no matching method.
// =============================================================================

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const API_DIR = join(ROOT, "src", "app", "api");

function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1) Route inventory: path pattern + exported methods
// ---------------------------------------------------------------------------
const routes = [];
for (const file of walk(API_DIR, [".ts", ".tsx"])) {
  if (!file.endsWith("route.ts") && !file.endsWith("route.tsx")) continue;
  const rel = relative(API_DIR, file).replace(/\\/g, "/");
  const dir = rel.replace(/\/route\.tsx?$/, "");
  // api/videos/[id]/comments -> ^/api/videos/[^/]+/comments$
  const pattern =
    "^/api/" +
    dir
      .split("/")
      .map((seg) =>
        seg.startsWith("[") && seg.endsWith("]")
          ? "[^/]+"
          : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      )
      .join("/") +
    "$";
  const src = readFileSync(file, "utf8");
  const methods = new Set(
    [...src.matchAll(/export\s+async\s+function\s+(GET|POST|PATCH|PUT|DELETE)/g)].map(
      (m) => m[1]
    )
  );
  routes.push({
    file: relative(ROOT, file),
    path: "/api/" + dir,
    pattern: new RegExp(pattern),
    methods,
  });
}

// ---------------------------------------------------------------------------
// 2) UI call sites: fetch("...") / fetch(`...`) + HTTP method
// ---------------------------------------------------------------------------
const uiFiles = [
  ...walk(join(ROOT, "src"), [".ts", ".tsx"]),
].filter((f) => {
  const rel = relative(ROOT, f).replace(/\\/g, "/");
  return !rel.startsWith("src/app/api/") && !rel.endsWith(".test.ts") && !rel.endsWith(".test.tsx");
});

// Extract every fetch( call with a proper paren-matching scan, then read the
// method from INSIDE that call only (a naive window grabs the next fetch's
// method and produces false positives).
function extractFetchCalls(src) {
  const out = [];
  let idx = 0;
  while ((idx = src.indexOf("fetch(", idx)) !== -1) {
    const prev = idx > 0 ? src[idx - 1] : " ";
    if (/[A-Za-z0-9_$]/.test(prev)) {
      idx += 6;
      continue;
    }
    let i = idx + 6;
    let depth = 1;
    let inStr = null;
    let esc = false;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === inStr) inStr = null;
      } else {
        if (c === '"' || c === "'" || c === "`") inStr = c;
        else if (c === "(") depth++;
        else if (c === ")") depth--;
      }
      i++;
    }
    const callSrc = src.slice(idx + 6, i);
    idx = i;
    const m = callSrc.match(/^\s*(?:"(\/api\/[^"]*)"|'(\/api\/[^']*)'|`(\/api\/[^`]*)`)/);
    if (!m) continue;
    const methodMatch = callSrc.match(/method:\s*["']([A-Za-z]+)["']/);
    out.push({
      raw: m[1] || m[2] || m[3] || "",
      method: methodMatch ? methodMatch[1].toUpperCase() : "GET",
    });
  }
  return out;
}

const calls = [];
for (const file of uiFiles) {
  const src = readFileSync(file, "utf8");
  for (const call of extractFetchCalls(src)) {
    calls.push({ file: relative(ROOT, file), ...call });
  }
}

// ---------------------------------------------------------------------------
// 3) Match call sites against the inventory
// ---------------------------------------------------------------------------
let missingRoute = 0;
let missingMethod = 0;
const seen = new Set();
const problems = [];

for (const call of calls) {
  let path = call.raw.split("?")[0];
  // ${...} segments are dynamic
  path = path
    .split("/")
    .map((seg) => (seg.includes("${") ? "__DYNAMIC__" : seg))
    .join("/");

  const key = `${call.method} ${path}`;
  if (seen.has(key)) continue;
  seen.add(key);

  const matched = routes.filter((r) =>
    r.pattern.test(path.replace(/__DYNAMIC__/g, "x"))
  );
  if (matched.length === 0) {
    missingRoute++;
    problems.push(`MISSING ROUTE   ${call.method} ${path}   (called from ${call.file})`);
  } else if (!matched.some((r) => r.methods.has(call.method))) {
    missingMethod++;
    const have = [...new Set(matched.flatMap((r) => [...r.methods]))].join(",") || "none";
    problems.push(
      `MISSING METHOD  ${call.method} ${path}   (route exports: ${have}; called from ${call.file})`
    );
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log(`\n=== GENHUB endpoint audit ===`);
console.log(`routes on disk: ${routes.length} | ui fetch call sites: ${calls.length} (unique method+path: ${seen.size})\n`);

if (problems.length === 0) {
  console.log("  OK  every UI fetch() maps to an existing route + method\n");
} else {
  for (const p of problems) console.log(`  ${p}`);
  console.log(
    `\n${missingRoute} missing route(s), ${missingMethod} missing method(s)\n`
  );
}

// Info: routes never referenced from the UI (cron/webhook/server-to-server
// endpoints are expected here — this is a signal, not a failure)
const calledPaths = [
  ...new Set(calls.map((c) => c.raw.split("?")[0])),
];
function pathMatches(routePath, callPath) {
  const a = routePath.split("/");
  const b = callPath.split("/");
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg.startsWith("[") || seg === b[i]);
}
const orphans = routes.filter(
  (r) => !calledPaths.some((p) => pathMatches(r.path, p))
);
if (orphans.length) {
  console.log(
    `info: ${orphans.length} route(s) not called directly from UI (cron/webhook/server/lib — usually fine):`
  );
  for (const o of orphans) console.log(`   - ${o.file}`);
  console.log();
}

process.exit(problems.length > 0 ? 1 : 0);
