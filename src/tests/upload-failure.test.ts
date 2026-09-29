// =============================================================================
// GENHUB - Recorded upload failures
//
// The property worth pinning is not "it stores an object". It is that a
// diagnostic never becomes a new problem:
//
//   * the LOG line is written even when the cache cannot be, because the
//     provider's log outlives both the cache entry and this deployment;
//   * the list is bounded and newest-first, or the one screen that answers
//     "why is this failing?" turns into an unreadable pile;
//   * nothing here throws — a failure to record a failure must not become the
//     third failure of the day;
//   * the schema bounds what a browser may put on the admin panel.
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
  recordUploadFailure,
  listUploadFailures,
  type UploadFailure,
} from "@/lib/services/upload-failure.service";
import { uploadFailureSchema } from "@/lib/validation";

const failure = {
  code: "NETWORK",
  stage: "chunk" as const,
  status: 400,
  message: 'Upload failed (HTTP 400): {"message":"Library ID missing or invalid."}',
  providerBody: '{"statusCode":400,"message":"Library ID missing or invalid."}',
  bunnyVideoId: "3d2229c4-7187-4e8c-bee2-d2e8ddca6d9a",
  fileName: "scene.mp4",
  fileSize: 650 * 1024 * 1024,
  bytesSent: 12 * 1024 * 1024,
  bytesTotal: 650 * 1024 * 1024,
  reason: "provider" as const,
  offset: 12 * 1024 * 1024,
  chunkIndex: 3,
  retryCount: 1,
  attemptMs: [12, 9, 14, 11, 13, 10],
  userAgent:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Mobile Safari/537.36",
  connectionType: "4g",
  downlinkMbps: 1.5,
  rttMs: 180,
  creatorId: "creator-1",
};

let logged: string[] = [];
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  logged = [];
  errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
  mocks.cacheGet.mockResolvedValue(null);
  mocks.cacheSet.mockResolvedValue(undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("recordUploadFailure", () => {
  it("names the fault and the chunk, not only the verdict", async () => {
    // "NETWORK" is a verdict; "offline" is a cause, and they lead to different
    // actions. The chunk and retry counts say whether this was one drop or a
    // connection refusing the same bytes over and over.
    const entry = await recordUploadFailure({ ...failure, reason: "offline", retryCount: 3 });

    expect(entry.reason).toBe("offline");
    expect(entry.chunkIndex).toBe(3);
    expect(entry.retryCount).toBe(3);

    const line = logged.join("\n");
    expect(line).toContain("(offline)");
    expect(line).toContain("chunk 3");
    expect(line).toContain("retry 3");
  });

  it("names the browser and the shape of the attempts, not only the retry count", async () => {
    // The gap this closes, seen live: thirteen reports from one creator's phone,
    // every one of them "NETWORK · chunk · 6 retries", all with the server
    // offset sitting at zero. Nothing in the record said which browser, which
    // link, or whether the attempts had lasted milliseconds or minutes — and
    // those are the only three things that could have told a request that never
    // left the handset from a transfer that kept being cut.
    const entry = await recordUploadFailure({ ...failure, reason: "reset", attemptMs: [12, 9, 14] });

    expect(entry.attemptMs).toEqual([12, 9, 14]);
    expect(entry.userAgent).toContain("Chrome/113");
    expect(entry.connectionType).toBe("4g");

    const line = logged.join("\n");
    // The numbers, not a summary of them: "attempts of a few milliseconds" is a
    // judgement, and the reader is the one who gets to make it.
    expect(line).toContain("attempts 12ms, 9ms, 14ms");
    expect(line).toContain("on 4g");
    expect(line).toContain("1.5 Mbps down");
    expect(line).toContain("180 ms rtt");
    expect(line).toContain("Chrome/113");
  });

  it("keeps Bunny's status and body, which are the reason the record exists", async () => {
    const entry = await recordUploadFailure(failure);

    expect(entry.status).toBe(400);
    expect(entry.providerBody).toContain("Library ID missing");
    expect(entry.stage).toBe("chunk");
    expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const [, stored] = mocks.cacheSet.mock.calls[0];
    expect((stored as UploadFailure[])[0].providerBody).toContain("Library ID missing");
  });

  it("writes the log line, and does not throw, when the cache cannot be read", async () => {
    // The cache is allowed to be down. The log is the copy that survives it, so
    // it is written first and unconditionally — and a failure to RECORD a
    // failure must not become the third failure of the day on the client's side.
    mocks.cacheGet.mockRejectedValue(new Error("redis is gone"));

    await expect(recordUploadFailure(failure)).resolves.toMatchObject({ code: "NETWORK" });
    expect(logged.join("\n")).toContain("[Upload Failure]");
    expect(logged.join("\n")).toContain("HTTP 400");
    expect(logged.join("\n")).toContain("Library ID missing");
  });

  it("records how far the transfer got, which is what a report could not say before", async () => {
    // The shape of the four reports that prompted this: NETWORK, no HTTP status,
    // no Bunny body. Nothing in the entry said whether the browser had ever put
    // a byte on the wire.
    const entry = await recordUploadFailure({
      ...failure,
      status: null,
      providerBody: null,
      bytesSent: 0,
    });

    expect(entry.bytesSent).toBe(0);
    expect(entry.bytesTotal).toBe(failure.bytesTotal);
    // Said out loud in the log, because a bare "NETWORK" is the whole problem.
    expect(logged.join("\n")).toContain("died at 0.0 of 650.0 MB");
  });

  it("puts the newest first and never grows past the cap", async () => {
    const existing: UploadFailure[] = Array.from({ length: 25 }, (_, i) => ({
      ...failure,
      at: new Date(Date.now() - i * 1000).toISOString(),
      message: `old ${i}`,
    }));
    mocks.cacheGet.mockResolvedValue(existing);

    await recordUploadFailure({ ...failure, message: "the newest" });

    const [, stored] = mocks.cacheSet.mock.calls[0];
    const list = stored as UploadFailure[];
    expect(list).toHaveLength(25);
    expect(list[0].message).toBe("the newest");
    // The oldest fell off rather than the list growing without bound.
    expect(list.some((e) => e.message === "old 24")).toBe(false);
  });

  it("survives a cache holding something that is not a list", async () => {
    mocks.cacheGet.mockResolvedValue({ nope: true });

    await recordUploadFailure(failure);

    const [, stored] = mocks.cacheSet.mock.calls[0];
    expect(stored).toHaveLength(1);
  });
});

describe("listUploadFailures", () => {
  it("returns nothing at all when the cache has no entry", async () => {
    expect(await listUploadFailures()).toEqual([]);
  });

  it("normalises an entry written before the byte counts existed", async () => {
    // A real incident, not a hypothetical: the first entries in the live list
    // predate these fields, so they arrive with them ABSENT — and `undefined`
    // passes a `!== null` guard, which is how four genuine failures rendered as
    // "Died after NaN MB of NaN MB". The panel tests for a number; this makes
    // that test the only thing it needs.
    const older = { ...failure, at: new Date().toISOString() };
    delete (older as { bytesSent?: unknown }).bytesSent;
    delete (older as { bytesTotal?: unknown }).bytesTotal;
    // The same hazard for the fields added with them — the panel prints the
    // server offset with arithmetic, so an absent number there is another NaN.
    delete (older as { reason?: unknown }).reason;
    delete (older as { offset?: unknown }).offset;
    delete (older as { chunkIndex?: unknown }).chunkIndex;
    delete (older as { retryCount?: unknown }).retryCount;
    mocks.cacheGet.mockResolvedValue([older]);

    const [entry] = await listUploadFailures();

    expect(entry.bytesSent).toBeNull();
    expect(entry.bytesTotal).toBeNull();
    expect(entry.reason).toBeNull();
    expect(entry.offset).toBeNull();
    expect(entry.chunkIndex).toBeNull();
    expect(entry.retryCount).toBeNull();
  });

  it("normalises the fields added after those, so the panel never maps over undefined", async () => {
    // The same hazard one layer further out. The panel maps over `attemptMs` to
    // print the timings, and `undefined.map` is a crash — on the one screen that
    // exists to explain an incident, during the incident.
    const older: Record<string, unknown> = { ...failure, at: new Date().toISOString() };
    delete older.attemptMs;
    delete older.userAgent;
    delete older.connectionType;
    delete older.downlinkMbps;
    delete older.rttMs;
    // A field that arrived as something other than a number is treated exactly
    // like one that never arrived, rather than being handed to the renderer.
    older.rttMs = "180";
    mocks.cacheGet.mockResolvedValue([older]);

    const [entry] = await listUploadFailures();

    expect(entry.attemptMs).toBeNull();
    expect(entry.userAgent).toBeNull();
    expect(entry.connectionType).toBeNull();
    expect(entry.downlinkMbps).toBeNull();
    expect(entry.rttMs).toBeNull();
  });

  it("never hands a malformed entry to the panel", async () => {
    const good = { ...failure, at: new Date().toISOString() };
    mocks.cacheGet.mockResolvedValue([good, null, "junk", { noAt: true }]);

    const list = await listUploadFailures();

    expect(list).toHaveLength(1);
    expect(list[0].code).toBe("NETWORK");
  });
});

describe("uploadFailureSchema", () => {
  it("accepts the report the browser actually sends", () => {
    const result = uploadFailureSchema.safeParse({
      code: "NETWORK",
      stage: "chunk",
      status: 400,
      message: "Upload failed (HTTP 400)",
      providerBody: '{"message":"boom"}',
      bunnyVideoId: "vid",
      fileName: "scene.mp4",
      fileSize: 1024,
    });

    expect(result.success).toBe(true);
  });

  it("accepts a failure that never reached the wire", () => {
    // EXPIRED and the size guards happen before any request, so there is no
    // status, no body and no stage — and refusing those would discard exactly
    // the reports worth reading.
    const result = uploadFailureSchema.safeParse({
      code: "EXPIRED",
      message: "The upload authorization expired before the upload started.",
    });

    expect(result.success).toBe(true);
  });

  it("refuses a status that cannot be an HTTP status", () => {
    expect(
      uploadFailureSchema.safeParse({ code: "NETWORK", message: "x", status: 9999 }).success
    ).toBe(false);
  });

  it("accepts how the browser describes itself, and bounds every number in it", () => {
    // Lenient about the browser itself — a new User-Agent or a connection type
    // we have never seen is still the answer to "which device is failing?" —
    // and strict about the shape, so the report cannot become a channel for
    // arbitrary blobs or for a clock that jumped overnight.
    expect(
      uploadFailureSchema.safeParse({
        code: "NETWORK",
        message: "The connection dropped during upload.",
        stage: "chunk",
        attemptMs: [12, 9, 14],
        connectionType: "4g",
        downlinkMbps: 1.5,
        rttMs: 180,
      }).success
    ).toBe(true);

    expect(
      uploadFailureSchema.safeParse({ code: "NETWORK", message: "x", attemptMs: [-1] }).success
    ).toBe(false);
    // Longer than any ladder the uploader can produce is not a report.
    expect(
      uploadFailureSchema.safeParse({
        code: "NETWORK",
        message: "x",
        attemptMs: Array.from({ length: 17 }, () => 1),
      }).success
    ).toBe(false);
    expect(
      uploadFailureSchema.safeParse({
        code: "NETWORK",
        message: "x",
        attemptMs: [60 * 60_000],
      }).success
    ).toBe(false);
    expect(
      uploadFailureSchema.safeParse({ code: "NETWORK", message: "x", downlinkMbps: -1 }).success
    ).toBe(false);
    expect(
      uploadFailureSchema.safeParse({ code: "NETWORK", message: "x", rttMs: 200_000 }).success
    ).toBe(false);
  });

  it("refuses a stage the client never sends", () => {
    expect(
      uploadFailureSchema.safeParse({ code: "NETWORK", message: "x", stage: "whatever" }).success
    ).toBe(false);
  });

  it("requires a code and a message to render", () => {
    expect(uploadFailureSchema.safeParse({ message: "x" }).success).toBe(false);
    expect(uploadFailureSchema.safeParse({ code: "NETWORK" }).success).toBe(false);
  });

  it("accepts how far the transfer got, and bounds a negative", () => {
    expect(
      uploadFailureSchema.safeParse({
        code: "NETWORK",
        message: "The connection dropped during upload.",
        stage: "chunk",
        bytesSent: 0,
        bytesTotal: 650 * 1024 * 1024,
      }).success
    ).toBe(true);

    expect(
      uploadFailureSchema.safeParse({ code: "NETWORK", message: "x", bytesSent: -1 }).success
    ).toBe(false);
  });
});
