// =============================================================================
// GENHUB - Which half of the upload storage is missing
//
// The presigned path needs six variables in two halves: the four that name the
// bucket and let this server sign a URL for it, and the two that let it ask
// video-ingest to move the object into the reserved Bunny slot.
//
// The rule that guarded them was a COMPARISON — warn when the halves disagree —
// and a comparison has a hole that an upload test fell into: a deployment with
// all six absent is equal to itself, so it warned about nothing, refused every
// reservation with a 503, and looked from /api/health exactly like a deployment
// that was fully configured. A wrong-looking silence is the failure mode these
// tests exist for, so they pin the flags AND the words.
//
// config resolves its values once at module load, so each case re-imports it
// against a controlled environment.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const KEYS = [
  "NODE_ENV",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "VIDEO_INGEST_URL",
  "VIDEO_INGEST_SECRET",
] as const;

// NODE_ENV is typed as read-only, and the warning path only runs in production.
const mutableEnv = process.env as Record<string, string | undefined>;

const saved: Record<string, string | undefined> = {};

/** Every variable the path needs, with values that are obviously placeholders. */
const COMPLETE: Record<string, string> = {
  R2_ACCOUNT_ID: "5492c7dfae50c7be6388a2e6558da365",
  R2_ACCESS_KEY_ID: "test-access-key-id",
  R2_SECRET_ACCESS_KEY: "test-secret-access-key",
  R2_BUCKET: "genhub-uploads",
  VIDEO_INGEST_URL: "https://genhub-video-ingest.genhub.workers.dev",
  VIDEO_INGEST_SECRET: "a".repeat(64),
};

beforeEach(() => {
  for (const k of KEYS) saved[k] = mutableEnv[k];
  for (const k of KEYS) delete mutableEnv[k];
  vi.resetModules();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete mutableEnv[k];
    else mutableEnv[k] = saved[k];
  }
  vi.resetModules();
});

/** Import config fresh against the given environment, on top of a clean slate. */
async function loadConfig(env: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(env)) mutableEnv[k] = v;
  return import("@/lib/config");
}

describe("uploadStorageReadiness", () => {
  it("reports both halves ready when all six variables are set", async () => {
    const { uploadStorageReadiness } = await loadConfig(COMPLETE);

    expect(uploadStorageReadiness()).toEqual({
      r2Configured: true,
      ingestConfigured: true,
      missing: [],
    });
  });

  it("names the two ingest variables when only the bucket half is configured", async () => {
    const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = COMPLETE;
    const { uploadStorageReadiness } = await loadConfig({
      R2_ACCOUNT_ID,
      R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY,
      R2_BUCKET,
    });

    expect(uploadStorageReadiness()).toEqual({
      r2Configured: true,
      ingestConfigured: false,
      missing: ["VIDEO_INGEST_URL", "VIDEO_INGEST_SECRET"],
    });
  });

  it("names the single R2 variable that is absent, rather than the whole half", async () => {
    const {
      R2_ACCOUNT_ID,
      R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY,
      VIDEO_INGEST_URL,
      VIDEO_INGEST_SECRET,
    } = COMPLETE;
    const { uploadStorageReadiness } = await loadConfig({
      R2_ACCOUNT_ID,
      R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY,
      VIDEO_INGEST_URL,
      VIDEO_INGEST_SECRET,
    });

    expect(uploadStorageReadiness().r2Configured).toBe(false);
    expect(uploadStorageReadiness().missing).toEqual(["R2_BUCKET"]);
  });

  it("counts a variable set to the empty string as missing, because that is how it behaves", async () => {
    const { uploadStorageReadiness } = await loadConfig({ ...COMPLETE, VIDEO_INGEST_SECRET: "" });

    expect(uploadStorageReadiness()).toEqual({
      r2Configured: true,
      ingestConfigured: false,
      missing: ["VIDEO_INGEST_SECRET"],
    });
  });

  it("reports all six by name when nothing is configured", async () => {
    const { uploadStorageReadiness } = await loadConfig();

    expect(uploadStorageReadiness()).toEqual({
      r2Configured: false,
      ingestConfigured: false,
      missing: [
        "R2_ACCOUNT_ID",
        "R2_ACCESS_KEY_ID",
        "R2_SECRET_ACCESS_KEY",
        "R2_BUCKET",
        "VIDEO_INGEST_URL",
        "VIDEO_INGEST_SECRET",
      ],
    });
  });
});

describe("productionConfigWarnings and the upload storage", () => {
  const pairWarning = (warnings: string[]) => warnings.find((w) => w.includes("must be set together"));
  const absentWarning = (warnings: string[]) =>
    warnings.find((w) => w.includes("no upload storage is configured"));

  it("says which half is missing when the two halves disagree", async () => {
    const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = COMPLETE;
    const { productionConfigWarnings } = await loadConfig({
      NODE_ENV: "production",
      R2_ACCOUNT_ID,
      R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY,
      R2_BUCKET,
    });

    const sentence = pairWarning(productionConfigWarnings());
    expect(sentence).toBeDefined();
    // The suffix is the part that answers "which half", so that is the part under
    // test. The sentence BODY names all six as a group on purpose — that shape is
    // what left the reader to work out which of them was absent.
    const [, named = ""] = (sentence as string).split("(missing: ");
    expect(named).toContain("VIDEO_INGEST_URL");
    expect(named).toContain("VIDEO_INGEST_SECRET");
    // The half that IS configured must not be reported as missing, or the reader
    // is sent to a console that has nothing wrong with it.
    expect(named).not.toContain("R2_BUCKET");
  });

  it("still warns when NOTHING is configured, which two equal halves could not", async () => {
    const { productionConfigWarnings } = await loadConfig({ NODE_ENV: "production" });

    const warnings = productionConfigWarnings();
    const sentence = absentWarning(warnings);
    expect(sentence).toBeDefined();
    expect(sentence).toContain("R2_ACCOUNT_ID");
    expect(sentence).toContain("VIDEO_INGEST_SECRET");
    // The comparison warning is for a half-configured deployment; saying both
    // would describe one deployment as two different problems.
    expect(pairWarning(warnings)).toBeUndefined();
  });

  it("says nothing about the upload storage when all six are set", async () => {
    const { productionConfigWarnings } = await loadConfig({ NODE_ENV: "production", ...COMPLETE });

    const warnings = productionConfigWarnings();
    expect(pairWarning(warnings)).toBeUndefined();
    expect(absentWarning(warnings)).toBeUndefined();
  });

  it("stays quiet outside production, where a missing bucket is ordinary", async () => {
    const { productionConfigWarnings } = await loadConfig({ NODE_ENV: "development" });

    expect(productionConfigWarnings()).toEqual([]);
  });
});
