// =============================================================================
// GENHUB - The hardening that lives in next.config.js
//
// Headers, source maps and the image allow-list are all one-line settings, and a
// one-line setting is exactly the kind of thing a later commit removes while
// chasing something else. The config is loaded in a CHILD PROCESS with
// NODE_ENV=production, because that is the only way to see the production values
// of a file whose own conditions read `process.env.NODE_ENV` at load time — and
// a test that checks the development branch and calls it production hardening is
// worse than no test.
//
// Nothing here prints a configuration value: only whether a header is present,
// and where a disallowed host would have been.
// =============================================================================

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

interface LoadedConfig {
  poweredByHeader?: boolean;
  productionBrowserSourceMaps?: boolean;
  imageHosts: string[];
  headers: Record<string, string>;
}

/** Load next.config.js the way `next build` does, and report only the shape. */
function loadProductionConfig(): LoadedConfig {
  const script = `
    const config = require("./next.config.js");
    (async () => {
      const entries = await config.headers();
      const headers = {};
      for (const entry of entries) {
        for (const header of entry.headers) headers[header.key] = header.value;
      }
      const patterns = (config.images && config.images.remotePatterns) || [];
      console.log(JSON.stringify({
        poweredByHeader: config.poweredByHeader,
        productionBrowserSourceMaps: config.productionBrowserSourceMaps,
        imageHosts: patterns.map((p) => p.hostname),
        headers,
      }));
    })().catch((error) => { console.error(error); process.exit(1); });
  `;

  const out = execFileSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "production" },
    encoding: "utf8",
  });
  return JSON.parse(out.trim().split("\n").pop() as string);
}

const config = loadProductionConfig();

describe("response headers", () => {
  it("sends the full hardening set", () => {
    for (const header of [
      "Content-Security-Policy",
      "Strict-Transport-Security",
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Referrer-Policy",
      "Permissions-Policy",
    ]) {
      expect(config.headers[header], `${header} is missing`).toBeTruthy();
    }
  });

  it("keeps the clickjacking protection on both header generations", () => {
    // X-Frame-Options for older browsers, frame-ancestors for the ones that read
    // the modern directive. A CSP without frame-ancestors silently drops the
    // protection in every browser that ignores the legacy header.
    expect(config.headers["X-Frame-Options"]).toBe("DENY");
    expect(config.headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  });

  it("never allows eval in a production policy", () => {
    // React's dev build uses eval for readable stacks; production does not need
    // it, and 'unsafe-eval' is the single directive that turns a strict CSP back
    // into a suggestion.
    expect(config.headers["Content-Security-Policy"]).not.toContain("unsafe-eval");
  });

  it("denies the capabilities the app never asks for", () => {
    const policy = config.headers["Permissions-Policy"];
    expect(policy).toContain("camera=()");
    expect(policy).toContain("microphone=()");
    expect(policy).toContain("geolocation=()");
  });

  it("locks the object and framing surfaces shut", () => {
    const csp = config.headers["Content-Security-Policy"];
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("default-src 'self'");
  });
});

describe("fingerprinting", () => {
  it("does not announce the framework", () => {
    expect(config.poweredByHeader).toBe(false);
  });

  it("ships no production source maps", () => {
    // The default is false; this asserts it is false ON PURPOSE, so a later
    // "easier debugging" commit has to delete a test to reverse it.
    expect(config.productionBrowserSourceMaps).toBe(false);
  });
});

describe("the image allow-list", () => {
  it("carries no demo host into a production build", () => {
    // picsum.photos and i.pravatar.cc exist for the development-only demo
    // fallbacks, which are dead code in a production bundle. Every host here is
    // a host a client-supplied next/image src can have our server fetch.
    expect(config.imageHosts).not.toContain("picsum.photos");
    expect(config.imageHosts).not.toContain("i.pravatar.cc");
  });

  it("still allows the hosts real content is served from", () => {
    // Hardening must not blank the product: these are the storage and player
    // hosts the app actually uses.
    expect(config.imageHosts.length).toBeGreaterThan(0);
    expect(config.imageHosts.join(",")).toContain("storage.genhub.co.tz");
  });
});
