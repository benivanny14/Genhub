// =============================================================================
// GENHUB - The page's half of the ingest: keep asking until Bunny holds the file
//
// The step that failed at 100% is now several requests rather than one, so the
// behaviour worth pinning is all about the LOOP:
//
//   * it stops the moment the route says ready, and not one poll later;
//   * an unfinished round is continued, not reported as a failure — a creator
//     told their upload failed would send a gigabyte again for a move that costs
//     them nothing;
//   * a refusal carries the ROUTE's sentence, because the route is the side that
//     knows which of the reasons it is (`describeIngestFailure`), and a second
//     copy of that wording is how two screens start telling two stories;
//   * a creator who cancels is not shown a network error, and a loop that cannot
//     finish eventually says so instead of spinning.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VideoUploadError } from "@/lib/upload-error";
import { PREPARE_MAX_MS, PREPARE_POLL_MS, prepareVideoWithBunny } from "@/lib/upload-prepare";

const VIDEO_ID = "045b5638-6eff-45bb-8ef9-92479ebc3c3b";

/** The route's answer, in the shape /api/videos/ingest really sends. */
function routeAnswers(answers: Array<Record<string, unknown>>) {
  let index = 0;
  const impl = vi.fn(async () => {
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    return new Response(JSON.stringify(answer), {
      status: (answer.status as number) ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", impl);
  return impl;
}

const pending = (uploadedBytes: number, totalBytes: number) => ({
  success: true,
  data: { ready: false, uploadedBytes, totalBytes },
});

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("waiting for Bunny to hold the file", () => {
  it("resolves on the first answer when the file is already there", async () => {
    const fetchMock = routeAnswers([{ success: true, data: { ready: true, bytes: 1_000 } }]);

    await expect(prepareVideoWithBunny(VIDEO_ID)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps asking while the transfer is unfinished, and reports how far it is", async () => {
    const fetchMock = routeAnswers([
      pending(0, 2_000),
      pending(1_000, 2_000),
      { success: true, data: { ready: true, bytes: 2_000 } },
    ]);
    const progress: Array<[number, number]> = [];

    vi.useFakeTimers();
    const promise = prepareVideoWithBunny(VIDEO_ID, {
      onProgress: (uploaded, total) => progress.push([uploaded, total]),
    });
    // Each round is a request that has to happen before the next wait begins, so
    // the clock is advanced and the microtasks flushed together.
    await vi.advanceTimersByTimeAsync(PREPARE_POLL_MS);
    await vi.advanceTimersByTimeAsync(PREPARE_POLL_MS);
    await expect(promise).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(progress).toEqual([
      [0, 2_000],
      [1_000, 2_000],
      [2_000, 2_000],
    ]);
  });

  it("carries the route's own sentence when the video cannot be prepared", async () => {
    routeAnswers([
      {
        success: false,
        status: 503,
        error: "This deployment's upload storage is not configured, so the file cannot be prepared. Tell support.",
      },
    ]);

    const failure = await prepareVideoWithBunny(VIDEO_ID).catch((error) => error);

    expect(failure).toBeInstanceOf(VideoUploadError);
    expect((failure as VideoUploadError).message).toContain("not configured");
    expect((failure as VideoUploadError).status).toBe(503);
  });

  it("says the file will not be sent again when the connection to our own server dies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );

    const failure = await prepareVideoWithBunny(VIDEO_ID).catch((error) => error);

    expect((failure as VideoUploadError).code).toBe("NETWORK");
    // The file is already in the bucket, so a creator told only "upload failed"
    // would spend their data sending it a second time.
    expect((failure as VideoUploadError).message).toContain("will not send the file again");
  });

  it("calls a cancel a cancel, not a network error", async () => {
    routeAnswers([pending(0, 2_000)]);
    const controller = new AbortController();
    const promise = prepareVideoWithBunny(VIDEO_ID, { signal: controller.signal });

    const timer = setTimeout(() => controller.abort(), PREPARE_POLL_MS / 2);
    const failure = await promise.catch((error) => error);
    clearTimeout(timer);

    expect((failure as VideoUploadError).code).toBe("ABORTED");
  });

  it("stops waiting on a transfer that never finishes, rather than looping forever", async () => {
    const fetchMock = routeAnswers([pending(1_000, 2_000)]);

    vi.useFakeTimers();
    let failure: unknown;
    void prepareVideoWithBunny(VIDEO_ID).catch((error) => {
      failure = error;
    });

    const rounds = Math.ceil(PREPARE_MAX_MS / PREPARE_POLL_MS) + 2;
    for (let round = 0; round < rounds && failure === undefined; round += 1) {
      await vi.advanceTimersByTimeAsync(PREPARE_POLL_MS);
    }

    expect((failure as VideoUploadError).code).toBe("NETWORK");
    expect((failure as VideoUploadError).message).toContain("took too long");
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});
