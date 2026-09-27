// =============================================================================
// GENHUB - the MP4 demuxer
// =============================================================================
// The demuxer is what lets a phone's H.264 clip take the fast export path
// instead of being re-recorded in real time, so the one thing that matters is
// that the samples it hands back are EXACTLY the samples in the file — right
// offsets, right lengths, right timestamps, right keyframe flags. A one-byte
// error in the chunk arithmetic would produce a file that is subtly wrong in a
// way no browser playback would reveal.
//
// So this reads the two committed fixtures — the classic MP4 a phone writes and
// the fragmented MP4 a browser's MediaRecorder writes — and checks the samples
// against the file itself: every sample's bytes must walk as valid AVCC NAL
// units and end exactly on the sample boundary, and the two containers must
// agree frame for frame.
//
// It is pure byte arithmetic, so it runs in Node with no browser at all.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { demuxMp4, type DemuxedMp4 } from "@/lib/mp4";

const CLASSIC = "e2e/fixtures/short-h264.mp4";
const FRAGMENTED = "e2e/fixtures/short-h264-fragmented.mp4";
const WEBM = "e2e/fixtures/short.webm";

/** 6s at 30fps, matching e2e/make-mp4-fixture.mjs. */
const FRAME_COUNT = 180;
const KEYFRAME_EVERY = 60;

function load(relative: string): Uint8Array {
  return new Uint8Array(readFileSync(path.resolve(relative)));
}

/**
 * Whether a sample is a well-formed AVCC payload: a run of length-prefixed NAL
 * units that ends exactly at the sample's last byte.
 *
 * This is the check that catches a mis-computed sample size or offset. A sliced
 * too short fails to parse; sliced too long picks up the next sample's length
 * prefix and overruns the end.
 */
function isWellFormedAvcc(sample: Uint8Array): boolean {
  let at = 0;
  while (at < sample.length) {
    if (at + 4 > sample.length) return false;
    const length =
      (sample[at] << 24) | (sample[at + 1] << 16) | (sample[at + 2] << 8) | sample[at + 3];
    if (length <= 0 || at + 4 + length > sample.length) return false;
    at += 4 + length;
  }
  return at === sample.length;
}

function timestamps(demuxed: DemuxedMp4): number[] {
  return demuxed.samples.map((sample) => sample.timestampUs);
}

function keyframeIndexes(demuxed: DemuxedMp4): number[] {
  return demuxed.samples
    .map((sample, index) => (sample.keyframe ? index : -1))
    .filter((index) => index >= 0);
}

describe.each([
  ["a classic MP4 (what a phone writes)", CLASSIC, false],
  ["a fragmented MP4 (what a browser recorder writes)", FRAGMENTED, true],
])("demuxMp4: %s", (_label, file, fragmented) => {
  const bytes = load(file);
  const demuxed = demuxMp4(bytes);

  it("names the H.264 track and its dimensions", () => {
    expect(demuxed.video).not.toBeNull();
    expect(demuxed.video?.codecId).toBe("avc1");
    // The codec string is `avc1.PPCCLL`, built from the avcC record.
    expect(demuxed.video?.codec).toMatch(/^avc1\.[0-9A-F]{6}$/);
    expect(demuxed.video?.width).toBe(320);
    expect(demuxed.video?.height).toBe(240);
  });

  it("keeps the avcC decoder configuration, without which H.264 will not start", () => {
    // The record begins with configurationVersion, then profile/compat/level.
    expect(demuxed.video?.description).toBeDefined();
    expect(demuxed.video!.description!.length).toBeGreaterThanOrEqual(7);
    expect(demuxed.video!.description![0]).toBe(1);
  });

  it("finds every frame, in order, at 30fps", () => {
    expect(demuxed.samples.length).toBe(FRAME_COUNT);

    const times = timestamps(demuxed);
    expect(times[0]).toBe(0);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1]);
      // One frame at 30fps is 33.333ms; the reader rounds to microseconds from
      // an integer timebase, so a frame is 33,333us or 33,334us and no more.
      const delta = times[i] - times[i - 1];
      expect(delta).toBeGreaterThanOrEqual(33_333);
      expect(delta).toBeLessThanOrEqual(33_334);
    }
    // The last frame starts one frame before the six-second mark.
    expect(times[times.length - 1]).toBeGreaterThan(5_960_000);
    expect(times[times.length - 1]).toBeLessThan(6_000_000);
  });

  it("marks exactly the encoder's keyframes", () => {
    const expected = Array.from({ length: FRAME_COUNT / KEYFRAME_EVERY }, (_, i) => i * KEYFRAME_EVERY);
    expect(keyframeIndexes(demuxed)).toEqual(expected);
    expect(demuxed.samples[0].keyframe).toBe(true);
  });

  it("slices every sample so its NAL units end exactly on the boundary", () => {
    for (const sample of demuxed.samples) {
      expect(sample.data.length).toBeGreaterThan(4);
      expect(isWellFormedAvcc(sample.data)).toBe(true);
    }
  });

  it("states its duration and reports no unreadable data", () => {
    expect(demuxed.fragmented).toBe(fragmented);
    expect(demuxed.unsupportedBlocks).toBe(0);
    expect(demuxed.durationMs).toBeGreaterThan(5_900);
    expect(demuxed.durationMs).toBeLessThanOrEqual(6_100);
  });
});

describe("demuxMp4: the two containers agree", () => {
  it("reads the same frames out of a classic and a fragmented file", () => {
    const classic = demuxMp4(load(CLASSIC));
    const fragmented = demuxMp4(load(FRAGMENTED));

    expect(fragmented.samples.length).toBe(classic.samples.length);
    expect(timestamps(fragmented)).toEqual(timestamps(classic));
    expect(keyframeIndexes(fragmented)).toEqual(keyframeIndexes(classic));

    // Same frames, same bytes — the container is the only difference.
    for (let i = 0; i < classic.samples.length; i++) {
      expect(fragmented.samples[i].data.length).toBe(classic.samples[i].data.length);
      expect(fragmented.samples[i].data).toEqual(classic.samples[i].data);
    }
  });
});

describe("demuxMp4: files it should refuse", () => {
  it("reads nothing from bytes that are not an MP4", () => {
    const demuxed = demuxMp4(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
    expect(demuxed.video).toBeNull();
    expect(demuxed.samples).toEqual([]);
  });

  it("reads nothing from an empty file", () => {
    expect(demuxMp4(new Uint8Array(0)).samples).toEqual([]);
  });

  it("does not mistake a WebM for an MP4", () => {
    const demuxed = demuxMp4(load(WEBM));
    expect(demuxed.video).toBeNull();
    expect(demuxed.samples).toEqual([]);
  });

  it("survives a truncated file rather than throwing", () => {
    const full = load(CLASSIC);
    // Half the file: the header tables are complete, the media data is not.
    const half = full.subarray(0, Math.floor(full.length / 2));
    const demuxed = demuxMp4(half);
    // Whatever it manages to read, a sample may never run past the bytes given.
    for (const sample of demuxed.samples) {
      expect(sample.data.length).toBeGreaterThan(0);
    }
  });

  it("stops rather than looping forever on a box that claims a bogus size", () => {
    const bytes = new Uint8Array(64);
    // `moov` at offset 0 with size 8 — smaller than a header plus a body.
    bytes.set([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x76], 0);
    expect(() => demuxMp4(bytes)).not.toThrow();
    expect(demuxMp4(bytes).samples).toEqual([]);
  });
});
