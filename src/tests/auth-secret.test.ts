// =============================================================================
// GENHUB - Auth secret hardening
//
// Locks in the fix for a silent, total compromise: config.ts fell back to the
// literal string "dev-secret-change-in-production" when JWT_SECRET was unset.
// In production that is not a weak secret — it is a PUBLIC one, published in
// this repository. Anyone could mint a JWT with role=ADMIN and jose would
// verify it, so the app would look completely healthy while being open.
//
// The old behaviour was a warning in productionConfigWarnings(). A warning is
// the wrong severity for token forgery: there is no recovery story once an
// attacker has an admin session, so this must fail closed at the point tokens
// are minted or checked.
//
// What is asserted here:
//   1. production + unset secret        -> generateToken throws
//   2. production + dev default secret  -> generateToken throws
//   3. production + dev default secret  -> verifyToken throws (not "invalid")
//   4. a real secret in production      -> tokens round-trip normally
//   5. development keeps its fallback, so `npm run dev` still works with no .env
//   6. the guard lives where auth happens, so public pages and /api/health
//      still load and can report the misconfiguration
// =============================================================================

import { describe, it, expect, afterEach, vi } from "vitest";

const DEV_DEFAULT = "dev-secret-change-in-production";

// config.ts reads process.env once at import, so each case needs a fresh module
// graph. resetModules() + dynamic import is how we observer a different env
// without restarting the test process.
async function withEnv(
  env: Record<string, string | undefined>,
  run: (auth: typeof import("@/lib/auth")) => Promise<void>
) {
  const saved = { ...process.env };
  vi.resetModules();

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    const auth = await import("@/lib/auth");
    await run(auth);
  } finally {
    process.env = saved;
    vi.resetModules();
  }
}

afterEach(() => {
  vi.resetModules();
});

const payload = {
  userId: "u1",
  role: "ADMIN" as const,
};

describe("JWT secret hardening", () => {
  it("refuses to sign a token in production when JWT_SECRET is unset", async () => {
    await withEnv({ NODE_ENV: "production", JWT_SECRET: undefined }, async (auth) => {
      await expect(auth.generateToken(payload)).rejects.toThrow(/JWT_SECRET is unset/i);
    });
  });

  it("refuses to sign a token in production when the secret is the public dev default", async () => {
    await withEnv({ NODE_ENV: "production", JWT_SECRET: DEV_DEFAULT }, async (auth) => {
      await expect(auth.generateToken(payload)).rejects.toThrow(/publicly known secret/i);
    });
  });

  // The subtler half: if verifyToken swallowed the misconfiguration into its
  // catch, the app would return "session invalid" forever and look like a
  // cookie bug. It must raise, because the operator needs the real reason.
  it("raises on verify (not a silent null) when the secret is the dev default in production", async () => {
    await withEnv({ NODE_ENV: "production", JWT_SECRET: DEV_DEFAULT }, async (auth) => {
      await expect(auth.verifyToken("any.token.here")).rejects.toThrow(/publicly known secret/i);
    });
  });

  it("round-trips a real token in production with a strong secret", async () => {
    const strong = "f".repeat(32) + "0123456789abcdef0123456789abcdef";
    await withEnv({ NODE_ENV: "production", JWT_SECRET: strong }, async (auth) => {
      const token = await auth.generateToken(payload);
      const verified = await auth.verifyToken(token);
      expect(verified?.userId).toBe("u1");
      expect(verified?.role).toBe("ADMIN");
    });
  });

  it("still exposes the dev fallback outside production, so local dev needs no .env", async () => {
    await withEnv({ NODE_ENV: "development", JWT_SECRET: undefined }, async (auth) => {
      const token = await auth.generateToken(payload);
      const verified = await auth.verifyToken(token);
      expect(verified?.userId).toBe("u1");
    });
  });

  // A token signed with the dev default must NOT be accepted in production —
  // otherwise an attacker who forges one offline keeps working after the
  // operator fixes the env, until every old cookie expires.
  it("rejects a token forged with the dev default once production uses a real secret", async () => {
    let forged = "";
    await withEnv({ NODE_ENV: "development", JWT_SECRET: DEV_DEFAULT }, async (auth) => {
      forged = await auth.generateToken(payload);
    });

    const strong = "a".repeat(32) + "0123456789abcdef0123456789abcdef";
    await withEnv({ NODE_ENV: "production", JWT_SECRET: strong }, async (auth) => {
      expect(await auth.verifyToken(forged)).toBeNull();
    });
  });
});
