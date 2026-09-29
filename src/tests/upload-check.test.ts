// =============================================================================
// GENHUB - What the creator's phone said it could reach, kept
//
// The property worth pinning is not "it stores an object". It is that the verdict
// a creator reads on a phone screen survives the trip to the screen an operator is
// looking at, without becoming a new problem:
//
//   * the reading sentence goes into the LOG, because the provider's log outlives
//     both the cache entry and this deployment;
//   * the list is bounded, newest-first and deduplicated BY CREATOR, because the
//     question it answers is "which creator's phone cannot reach the bucket?" and
//     a creator who pressed the button four times must not crowd it out;
//   * nothing here throws — a check that cannot be recorded must not become a
//     second failure on a page whose only job is to explain the first one;
//   * the server's own observation of where the page was loaded from wins, and a
//     record written before a field existed still renders as a row.
//
// Redis is mocked: no cache and no network.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({
  cacheGet: (...args: unknown[]) => mocks.cacheGet(...args),
  cacheSet: (...args: unknown[]) => mocks.cacheSet(...args),
}));

import {
  recordUploadCheck,
  listUploadChecks,
  type UploadCheckRecord,
} from "@/lib/services/upload-check.service";

/** The check that ran on the phone this whole feature was built for: everything
 *  reachable, and every real write refused before it left the device. */
const refusedPart = {
  creatorId: "creator-1",
  origin: "https://genhub-two.vercel.app",
  userAgent:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36",
  connectionType: "3g",
  downlinkMbps: 0.4,
  rttMs: 750,
  reach: { ok: true, ms: 120 },
  whole: { ok: true, status: 200, ms: 210, etag: '"abc"' },
  part: { ok: false, status: null, ms: 45, error: "TypeError" },
};

let logged: string[] = [];
let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  logged = [];
  infoSpy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  mocks.cacheGet.mockResolvedValue(null);
  mocks.cacheSet.mockResolvedValue(undefined);
});

afterEach(() => {
  infoSpy.mockRestore();
});

describe("recordUploadCheck", () => {
  it("writes the reading, not only the numbers", async () => {
    // "refused (TypeError)" is evidence. What it MEANS — this device could not
    // take a part even though the host answered — is the sentence that decides
    // whether the fix is the network or the bucket's CORS policy, and it is
    // written into the log so one line answers the question.
    const entry = await recordUploadCheck(refusedPart);

    expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const line = logged.join("\n");
    expect(line).toContain("[Upload Check]");
    expect(line).toContain("part 1: refused");
    expect(line).toContain("(TypeError) in 45 ms");
    expect(line).toContain("reach: ok in 120 ms");
    // Where the page was open, and on what: the two fields that separate a
    // refused address from a phone with no signal.
    expect(line).toContain("from https://genhub-two.vercel.app");
    expect(line).toContain("on 3g");
    expect(line).toContain("0.4 Mbps down");
  });

  it("says a device that could not reach the host gives no information about permission", async () => {
    // Order matters, and this is the case that proves it: an unreachable host
    // EXPLAINS the refused write, so the reading must not additionally claim the
    // bucket's CORS policy is at fault. The first version of this sentence sent
    // the reader to the wrong system.
    await recordUploadCheck({
      ...refusedPart,
      reach: { ok: false, ms: 20_000, error: "TypeError" },
    });

    const line = logged.join("\n");
    expect(line).toMatch(/could not reach/i);
    expect(line).not.toMatch(/most likely the bucket's CORS policy/);
  });

  it("keeps the creator's own copy under their key as well as the list", async () => {
    // Two shapes on purpose: the list answers "who is affected?" and this answers
    // "what about THIS creator?", which is the question being asked while a
    // creator is on the phone.
    await recordUploadCheck(refusedPart);

    const keys = mocks.cacheSet.mock.calls.map((call) => call[0]);
    expect(keys).toContain("upload:check:creator-1");
    expect(keys.some((key) => typeof key === "string" && key !== "upload:check:creator-1")).toBe(
      true
    );
  });

  it("writes the log line, and does not throw, when the cache is gone", async () => {
    // The cache is allowed to be down. A check that cannot be recorded must not
    // become a second failure on the page that exists to explain the first.
    mocks.cacheGet.mockRejectedValue(new Error("redis is gone"));

    await expect(recordUploadCheck(refusedPart)).resolves.toMatchObject({
      creatorId: "creator-1",
    });
    expect(logged.join("\n")).toContain("part 1: refused");
  });

  it("puts the newest first and never grows past the cap", async () => {
    const existing: UploadCheckRecord[] = Array.from({ length: 25 }, (_, i) => ({
      at: new Date(Date.now() - i * 1000).toISOString(),
      creatorId: `creator-${i}`,
      reach: { ok: true, ms: 10 },
      whole: null,
      part: null,
    }));
    mocks.cacheGet.mockResolvedValue(existing);

    await recordUploadCheck({ ...refusedPart, creatorId: "the-newest" });

    const [, stored] = mocks.cacheSet.mock.calls[0];
    const list = stored as UploadCheckRecord[];
    expect(list).toHaveLength(25);
    expect(list[0].creatorId).toBe("the-newest");
    expect(list.some((entry) => entry.creatorId === "creator-24")).toBe(false);
  });
});

describe("listUploadChecks", () => {
  it("returns nothing at all when the cache has no entry", async () => {
    expect(await listUploadChecks()).toEqual([]);
  });

  it("keeps one row per creator — the newest — because that is the question", async () => {
    // The live annoyance this prevents: one creator pressing the button four
    // times while somebody watched, filling the panel and pushing the three other
    // affected creators off it.
    mocks.cacheGet.mockResolvedValue([
      { ...refusedPart, at: "2026-09-29T13:30:00.000Z", part: { ok: true, status: 200, ms: 90 } },
      { ...refusedPart, at: "2026-09-29T13:00:00.000Z" },
      {
        ...refusedPart,
        at: "2026-09-29T12:00:00.000Z",
        creatorId: "creator-2",
        part: { ok: false, status: 403, ms: 30 },
      },
    ]);

    const checks = await listUploadChecks();

    expect(checks).toHaveLength(2);
    // Newest first, and the LATEST of the creator who checked twice.
    expect(checks[0].at).toBe("2026-09-29T13:30:00.000Z");
    expect(checks[0].part?.ok).toBe(true);
    expect(checks[1].creatorId).toBe("creator-2");
  });

  it("normalises an entry that predates the fields the panel renders", async () => {
    // Everything after `whole/part/reach` arrived as the panel grew, and a
    // missing field is not `null`: the panel prints these with arithmetic and
    // compares proxies by identity, so absent values are folded into the shape
    // its type promises rather than handed to the renderer.
    mocks.cacheGet.mockResolvedValue([
      {
        at: "2026-09-29T13:00:00.000Z",
        creatorId: "old",
        reach: { ok: false, ms: 20_000 },
        whole: { ok: false, status: null, ms: 40 },
        part: null,
      },
    ]);

    const [entry] = await listUploadChecks();

    expect(entry.origin).toBeNull();
    expect(entry.userAgent).toBeNull();
    expect(entry.connectionType).toBeNull();
    expect(entry.downlinkMbps).toBeNull();
    expect(entry.rttMs).toBeNull();
    // A probe with no `error` stays undefined so it can be read as a probe, and a
    // probe that never recorded an outcome at all is dropped rather than
    // rendered as a pass.
    expect(entry.reach?.error).toBeUndefined();
    expect(entry.part).toBeNull();
  });

  it("never hands a malformed entry to the panel", async () => {
    mocks.cacheGet.mockResolvedValue([
      { at: "2026-09-29T13:00:00.000Z", creatorId: "good", reach: null, whole: null, part: null },
      null,
      "junk",
      { at: "2026-09-29T13:00:00.000Z" },
      { creatorId: "no-at" },
    ]);

    const checks = await listUploadChecks();

    expect(checks).toHaveLength(1);
    expect(checks[0].creatorId).toBe("good");
  });

  it("reads nothing at all when the cache holds something that is not a list", async () => {
    mocks.cacheGet.mockResolvedValue({ nope: true });

    expect(await listUploadChecks()).toEqual([]);
  });
});
