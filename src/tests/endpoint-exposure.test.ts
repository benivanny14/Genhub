// =============================================================================
// GENHUB - Who may see how this deployment is built
//
// The health endpoint used to publish the environment name, which providers were
// configured, which environment variables were MISSING, the background-worker
// verdict and every production configuration warning — to anyone who asked. That
// is a map of the deployment, handed to a scanner, in exchange for nothing an
// uptime monitor needs.
//
// The payload is now split, and both halves are pinned here:
//
//   * anonymous  -> `{ status }` and nothing else;
//   * ADMIN session or CRON_SECRET -> the diagnostics, unchanged.
//
// Read from source on purpose: `GET` reaches the database and a cookie jar, so a
// test that called it would be testing the mocks. What matters is the shape the
// code can produce, and that is a property of the code.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

const health = read("src", "app", "api", "health", "route.ts");

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

describe("GET /api/health", () => {
  it("answers an anonymous caller with the verdict alone", () => {
    // Everything after the public verdict is computed; the return there is the
    // whole of what a stranger receives.
    const publicHalf = health.slice(health.lastIndexOf("const status = await publicStatus();"));
    // From the return onwards: the body's own text, not the comment above it that
    // says what is deliberately absent.
    const returned = publicHalf.slice(publicHalf.indexOf("return Response.json("));

    expect(returned).toMatch(/^return Response\.json\(\s*\{\s*status\s*\},\s*\{/);
    for (const internal of ["nodeEnv", "checks", "uptimeSec", "timestamp"]) {
      expect(returned, `${internal} is in the public payload`).not.toContain(internal);
    }
  });

  it("puts the diagnostics behind a check, not in front of it", () => {
    expect(health).toContain("if (await mayReadDiagnostics(request))");
    // And the check is the two things this app already treats as authority: a
    // live ADMIN row, or the shared secret the schedules carry.
    expect(health).toContain("requireCronSecret(request)");
    expect(health).toContain('user?.role === "ADMIN"');
  });

  it("resolves the admin role from the database rather than from a header", () => {
    // No `x-role`, no token claim: getCurrentUser goes through the same live role
    // read every privileged route uses.
    expect(health).toContain("getCurrentUser()");
    expect(health).not.toMatch(/headers\.get\(["']x-(role|admin)/i);
  });

  it("never lets a cached answer be served after the database goes away", () => {
    expect(health).toContain('"Cache-Control": "no-store, max-age=0"');
    // The public memo is short-lived and only ever answers "up" from a live read.
    expect(health).toContain("PUBLIC_VERDICT_TTL_MS");
  });

  it("keeps the public check cheap on purpose", () => {
    // A monitor polling every five seconds must not run the schema probe, the
    // worker probe and the configuration audit each time. The public half asks
    // one question; the expensive reads live in the diagnostics.
    const publicHalf = health.slice(
      health.indexOf("async function publicStatus"),
      health.indexOf("async function mayReadDiagnostics")
    );
    expect(publicHalf).toContain("SELECT 1");
    expect(publicHalf).not.toContain("getCronHealth");
    expect(publicHalf).not.toContain("productionConfigWarnings");
  });
});

describe("diagnostic endpoints", () => {
  it("require the cron secret, so the watchdog can read them and a stranger cannot", () => {
    const services = read("src", "app", "api", "health", "services", "route.ts");
    expect(services).toContain("requireCronSecret(request)");
  });

  it("keep the owner's view of the app behind an ADMIN session", () => {
    const attention = read("src", "app", "api", "health", "attention", "route.ts");
    const payments = read("src", "app", "api", "payments", "health", "route.ts");
    for (const source of [attention, payments]) {
      expect(source).toMatch(/requireRole\(["']ADMIN["']\)|requireCronSecret\(/);
    }
  });
});

describe("every admin route authorizes server-side", () => {
  const adminRoutes = routeFiles(join(process.cwd(), "src", "app", "api", "admin"));

  it("exists to scan", () => {
    expect(adminRoutes.length).toBeGreaterThan(15);
  });

  it("calls requireRole('ADMIN') and never trusts a client-side role", () => {
    const offenders: string[] = [];
    for (const file of adminRoutes) {
      const source = readFileSync(file, "utf8");
      if (!/requireRole\(["']ADMIN["']\)/.test(source)) {
        offenders.push(`${file} has no server-side ADMIN check`);
      }
      // A role read off a HEADER would be a role the caller chooses for
      // themselves. (A `?role=` query parameter is a list FILTER on the users
      // admin screen, not an authorization decision — so it is not flagged.)
      if (/headers?\.get\(["']x-(role|admin|user-role)/i.test(source)) {
        offenders.push(`${file} trusts a role header`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("development-only endpoints", () => {
  it("are guarded by the two-signal check, not by NODE_ENV alone", () => {
    for (const file of [
      ["dev", "sandbox", "complete"],
      ["demo", "seed"],
      ["auth", "demo-login"],
    ]) {
      const source = read("src", "app", "api", ...file, "route.ts");
      // One implementation, one name: `developmentOnlyEnabled()` is the two-signal
      // check (NODE_ENV and a localhost app URL), so a route that stops calling it
      // is a route that went back to trusting a single environment variable.
      expect(source, `${file.join("/")} lost its guard`).toContain(
        "developmentOnlyEnabled"
      );
    }
  });
});
