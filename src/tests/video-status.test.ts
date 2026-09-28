// =============================================================================
// GENHUB - Instant publication: the three states a post can be in
//
// A post now exists the moment its bytes reach the host, which means the feed
// and the watch page both have to answer a question that has two right answers:
// "is this live?" yes, and "can this play?" not yet.
//
// Two failure modes are pinned here, because both were real:
//
//   1. Treating an untracked video (encodingStatus null — every side-loaded,
//      demo and pre-lifecycle row) as "processing" would badge the whole
//      catalogue with a spinner nothing could ever clear.
//   2. Treating progress 100 as "processing" would strand a finished video
//      behind that same badge — the exact shape of the bug where status 3 was
//      read as "Transcoding" and creators reported "it never goes up".
//
// The poller's give-up rule is here too: a tab left open must stop asking.
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  PROCESSING_POLL_MAX_MS,
  isProcessingStatus,
  videoStatus,
} from "@/lib/video-status";
import { shouldKeepPolling } from "@/hooks/useVideoStatuses";

describe("videoStatus", () => {
  it("calls a video Bunny never tracked READY, not processing", () => {
    // Side-loaded, demo and pre-lifecycle rows. They play, and there is nothing
    // to wait for — a badge here would be permanent and wrong.
    expect(videoStatus(null, 0)).toBe("READY");
    expect(videoStatus(undefined, 0)).toBe("READY");
  });

  it("reads Bunny's queued/processing/encoding codes as PROCESSING", () => {
    expect(videoStatus(0, 0)).toBe("PROCESSING");
    expect(videoStatus(1, 42)).toBe("PROCESSING");
    expect(videoStatus(2, 99)).toBe("PROCESSING");
  });

  it("reads both finished codes as READY", () => {
    expect(videoStatus(3, 100)).toBe("READY");
    // 4 is "one resolution finished" — Bunny's own signal that it can play.
    expect(videoStatus(4, 80)).toBe("READY");
  });

  it("treats progress 100 as finished however the code reads", () => {
    // The third, independent signal: one wrong number must not hold an upload
    // behind a badge forever.
    expect(videoStatus(2, 100)).toBe("READY");
  });

  it("keeps a failed encode out of the READY/PROCESSING pair entirely", () => {
    expect(videoStatus(5, 0)).toBe("FAILED");
    expect(videoStatus(5, 100)).toBe("FAILED");
  });

  it("only calls PROCESSING processing", () => {
    expect(isProcessingStatus("PROCESSING")).toBe(true);
    expect(isProcessingStatus("READY")).toBe(false);
    expect(isProcessingStatus("FAILED")).toBe(false);
    expect(isProcessingStatus(null)).toBe(false);
  });
});

describe("the client poller's give-up rule", () => {
  const processing = { status: "PROCESSING" as const, progress: 40 };
  const ready = { status: "READY" as const, progress: 100 };

  it("asks about a video it has never heard about", () => {
    expect(shouldKeepPolling("v1", undefined, Date.now())).toBe(true);
  });

  it("keeps asking while a video is processing", () => {
    expect(shouldKeepPolling("v1", processing, Date.now())).toBe(true);
  });

  it("stops the moment the video is playable", () => {
    // This is what makes polling cost nothing on a normal page: nothing
    // unfinished, nothing asked.
    expect(shouldKeepPolling("v1", ready, Date.now())).toBe(false);
  });

  it("gives up on a video that never finishes", () => {
    const seenAt = Date.now() - (PROCESSING_POLL_MAX_MS + 1);
    expect(shouldKeepPolling("v1", processing, seenAt)).toBe(false);
  });

  it("keeps asking right up to the deadline", () => {
    const seenAt = Date.now() - (PROCESSING_POLL_MAX_MS - 1_000);
    expect(shouldKeepPolling("v1", processing, seenAt)).toBe(true);
  });
});
