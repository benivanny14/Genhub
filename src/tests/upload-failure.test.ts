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

  it("refuses a stage the client never sends", () => {
    expect(
      uploadFailureSchema.safeParse({ code: "NETWORK", message: "x", stage: "whatever" }).success
    ).toBe(false);
  });

  it("requires a code and a message to render", () => {
    expect(uploadFailureSchema.safeParse({ message: "x" }).success).toBe(false);
    expect(uploadFailureSchema.safeParse({ code: "NETWORK" }).success).toBe(false);
  });
});
