// =============================================================================
// GENHUB - What a failure is allowed to say to a client
//
// Two halves, both required:
//
//   * the runtime behaviour of the helpers (a 5xx is one plain sentence plus a
//     short reference; the diagnostic never travels), and
//   * a source scan over every route, because the helpers can be bypassed — one
//     `api.error(\`Bunny said ${error.message}\`)` is all it takes, and that is
//     exactly the shape this repo had in several places.
//
// The scan is deliberately about the things that must not appear in a
// client-facing string: a provider or vendor name, an environment-variable name,
// a database client, a CDN hostname, and `.stack`. It is not a proof; it is a
// tripwire that fails the build when someone reintroduces the pattern.
// =============================================================================

import { describe, it, expect, vi, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { api, GENERIC_SERVER_ERROR } from "@/lib/api-response";

afterEach(() => vi.restoreAllMocks());

/** The reference alphabet: crockford-ish base32, no I/L/O/U. */
const REFERENCE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("api.internal", () => {
  it("answers with one plain sentence and a reference", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = api.internal();

    expect(response.status).toBe(500);
    const body = await bodyOf(response);
    expect(body.success).toBe(false);
    expect(body.error).toBe(GENERIC_SERVER_ERROR);
    expect(String(body.reference)).toMatch(REFERENCE);
  });

  it("treats anything a caller passes as a diagnostic, never as the message", async () => {
    // The old signature let a caller hand the client a Prisma message. The value
    // is still logged — under the reference — and is not in the response.
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const diagnostic = "Unique constraint failed on the fields: (`email`)";
    const response = api.internal(diagnostic);

    const body = await bodyOf(response);
    expect(body.error).not.toContain("Unique constraint");
    expect(JSON.stringify(body)).not.toContain("Unique constraint");
    // The reference in the body is the reference on the log line, which is the
    // only thing that makes the reference worth showing.
    expect(log.mock.calls.join(" ")).toContain(String(body.reference));
  });
});

describe("api.upstream", () => {
  it("keeps the provider's words in the log and out of the response", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = api.upstream("gateway refused collect: invalid merchant float", {
      context: "Payments",
      status: 502,
      message: "We could not start the payment just now. Nothing has been charged.",
    });

    expect(response.status).toBe(502);
    const body = await bodyOf(response);
    expect(body.error).toBe(
      "We could not start the payment just now. Nothing has been charged."
    );
    expect(JSON.stringify(body).toLowerCase()).not.toContain("gateway");
    expect(JSON.stringify(body).toLowerCase()).not.toContain("float");
    expect(log.mock.calls.join(" ")).toContain("float");
  });

  it("still shows a reference when the sentence is generic", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const body = await bodyOf(api.upstream("upstream said no", { context: "Media" }));
    expect(String(body.reference)).toMatch(REFERENCE);
  });
});

describe("error responses are never cacheable", () => {
  it("sets no-store on a 5xx and on a 4xx", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const response of [api.internal(), api.forbidden(), api.notFound()]) {
      expect(response.headers.get("Cache-Control")).toContain("no-store");
    }
  });
});

// -----------------------------------------------------------------------------
// The tripwire
// -----------------------------------------------------------------------------
function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

const ROUTES = routeFiles(join(process.cwd(), "src", "app", "api"));

/** Things that describe HOW this deployment is built, not what went wrong. */
const FORBIDDEN_IN_MESSAGE = [
  "Bunny",
  "bunnycdn",
  "HarakaPay",
  "Prisma",
  "prisma",
  "Redis",
  "redis",
  "SMTP",
  "BUNNY_",
  "HARAKAPAY_",
  "CRON_SECRET",
  "JWT_SECRET",
  "DATABASE_URL",
  "process.env",
];

describe("every API route", () => {
  it("exists to scan", () => {
    expect(ROUTES.length).toBeGreaterThan(50);
  });

  it("never returns a stack", () => {
    const offenders = ROUTES.filter((file) => /\bstack\b/.test(readFileSync(file, "utf8")));
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("never hands an unexpected error's message to the client", () => {
    // The distinction that matters: `api.forbidden(error.message)` inside an
    // `instanceof AuthError` branch is a PRODUCT sentence ("Your account has
    // been suspended…"), which is why 401/403 are the two helpers excluded here.
    // `api.error(error.message)` is the message of an error nobody planned for,
    // and that is a Prisma line or a provider's words far too often.
    const offenders: string[] = [];
    for (const file of ROUTES) {
      const source = readFileSync(file, "utf8");
      if (/api\.(error|validation|notFound)\(\s*[a-zA-Z]\w*\.message/.test(source)) {
        offenders.push(`${file} returns a raw error message`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("never names a provider, vendor or environment variable in a response", () => {
    const offenders: string[] = [];
    for (const file of ROUTES) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!/api\.(error|validation|notFound|forbidden|unauthorized|rateLimited|upstream)\(/.test(line)) {
          return;
        }
        for (const token of FORBIDDEN_IN_MESSAGE) {
          if (line.includes(token)) {
            offenders.push(`${file}:${index + 1} names ${token}`);
          }
        }
      });
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("keeps an error's own words on the log side of the helper", () => {
    // `api.upstream(detail, options)` is where an upstream failure belongs: the
    // detail goes to the log with a reference, and the message is a sentence for
    // the user. What must not appear is an error's MESSAGE or STACK interpolated
    // into a client-facing string — that is the shape the payment routes had.
    const offenders: string[] = [];
    for (const file of ROUTES) {
      const source = readFileSync(file, "utf8");
      if (
        /api\.(error|validation|notFound|forbidden|unauthorized)\([\s\S]{0,400}?\$\{[^}]*\.(message|stack)\}/.test(
          source
        )
      ) {
        offenders.push(`${file} interpolates an error message into a response`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
