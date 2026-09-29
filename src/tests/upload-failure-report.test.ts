// =============================================================================
// GENHUB - Tests for what a failed upload says about itself
//
// Two rules are pinned here, and both were learned from a real incident:
//
//   1. The report carries FACTS the browser measured — the reason, the offset,
//      the attempt timings, what the link said about itself — not a paraphrase
//      of the toast. A row that only says "the upload connection was
//      interrupted" is true and useless, and it is the row this application had
//      for weeks.
//   2. When the record is read back, the BYTES decide the sentence and the
//      timings only add detail. The first version of that reading printed "no
//      upload progress was ever reported" directly above "bytes were moving" for
//      the same row; two sentences, one record, and they cannot both be true.
// =============================================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUploadFailureReport } from "@/lib/upload-failure-report";
import { describeUploadFailureAttempts, formatUploadBytes } from "@/lib/upload-failure-reading";
import { VideoUploadError, type VideoUploadSession } from "@/lib/video-upload";

afterEach(() => {
  vi.unstubAllGlobals();
});

function sessionFor(videoId = "slot-1"): VideoUploadSession {
  return {
    sessionToken: "token",
    videoId,
    uploadUrl: "https://video.bunnycdn.com/tusupload/session-1",
    headers: {},
    totalBytes: 145 * 1024 * 1024,
    expiresAt: Math.floor(Date.now() / 1000) + 3_600,
  };
}

/** A phone on 3G, as Chrome would describe it. */
function stubPhoneNetwork(): void {
  vi.stubGlobal("navigator", {
    onLine: true,
    connection: { effectiveType: "3g", downlink: 0.4, rtt: 150 },
  });
}

describe("buildUploadFailureReport", () => {
  it("carries the diagnosis rather than a paraphrase of the toast", () => {
    stubPhoneNetwork();
    const error = new VideoUploadError(
      "NETWORK",
      "The connection dropped while sending this video (43% sent).",
      undefined,
      { reason: "reset" }
    );
    error.stage = "chunk";
    error.offset = 62 * 1024 * 1024;
    error.bytesSent = 62 * 1024 * 1024;
    error.bytesTotal = 145 * 1024 * 1024;
    error.chunkIndex = 41;
    error.retryCount = 4;
    error.attemptMs = [1_200, 800, 40, 60, 90];

    const report = buildUploadFailureReport(error, {
      session: sessionFor(),
      file: new File([new Uint8Array(8)], "scene.mp4", { type: "video/mp4" }),
    });

    expect(report).toMatchObject({
      code: "NETWORK",
      reason: "reset",
      stage: "chunk",
      status: null,
      bunnyVideoId: "slot-1",
      offset: 62 * 1024 * 1024,
      bytesSent: 62 * 1024 * 1024,
      chunkIndex: 41,
      attemptMs: [1_200, 800, 40, 60, 90],
      // What the browser would say about its own link, so a 3G phone and a
      // fibre laptop do not arrive as the same row.
      connectionType: "3g",
      downlinkMbps: 0.4,
      rttMs: 150,
    });
    // The file comes from the context, not from the error: the transport never
    // held it.
    expect(report.fileName).toBe("scene.mp4");
  });

  it("names the teaser, and never throws on an error it does not recognize", () => {
    stubPhoneNetwork();

    const report = buildUploadFailureReport(new Error("boom"), { kind: "teaser" });

    expect(report.message).toMatch(/^Teaser: /);
    expect(report.code).toBe("UNKNOWN");
    // Every optional field is present and empty rather than absent: a report
    // whose shape changes with the failure is a report nobody can read.
    expect(report.reason).toBeNull();
    expect(report.providerBody).toBeNull();
    expect(report.attemptMs).toBeNull();
  });

  it("clips the message to what the column can hold", () => {
    stubPhoneNetwork();
    const report = buildUploadFailureReport(new VideoUploadError("NETWORK", "x".repeat(900)));
    expect(report.message).toHaveLength(300);
  });
});

describe("describeUploadFailureAttempts", () => {
  it("says nothing when there is nothing to read", () => {
    expect(describeUploadFailureAttempts({ bytesSent: null, attemptMs: null })).toBeNull();
    expect(describeUploadFailureAttempts({ bytesSent: 0, attemptMs: [] })).toBeNull();
  });

  it("reads a request that never left the device from its attempt timings", () => {
    // The live record that produced this rule: eight attempts, all under half a
    // second, no byte acknowledged. That is a route that refuses the host, not a
    // slow link — and the two want opposite answers.
    const sentence = describeUploadFailureAttempts({
      bytesSent: 0,
      attemptMs: [225, 35, 45, 258, 226, 233, 270, 475],
    });

    expect(sentence).toMatch(/no attempt lasted long enough to leave the device/);
    expect(sentence).toMatch(/8 attempt/);
  });

  it("reads a request that was cut mid-transfer from the same fields", () => {
    const sentence = describeUploadFailureAttempts({
      bytesSent: 0,
      attemptMs: [40_000, 45_000, 42_000],
    });

    expect(sentence).toMatch(/kept being cut before it started/);
  });

  it("lets the bytes decide the sentence, and never contradicts itself", () => {
    // Both facts at once: bytes acknowledged AND short attempts. The bytes win,
    // because the timings only describe how long each attempt stayed alive.
    const sentence = describeUploadFailureAttempts({
      bytesSent: 12 * 1024 * 1024,
      attemptMs: [10, 20, 30],
    });

    expect(sentence).toMatch(/already moving/);
    expect(sentence).not.toMatch(/no attempt lasted long enough/);
    expect(sentence).toMatch(new RegExp(formatUploadBytes(12 * 1024 * 1024)));
  });
});

describe("formatUploadBytes", () => {
  it("uses the unit a creator would say the file is", () => {
    expect(formatUploadBytes(780 * 1024)).toBe("780 KB");
    expect(formatUploadBytes(145 * 1024 * 1024)).toBe("145.0 MB");
  });
});
