// =============================================================================
// GENHUB - Which transport a file gets, and the XML that decides what it becomes
//
// Two rules that are cheap here and expensive in production:
//
//   * WHERE THE SPLIT IS. A file of exactly one part is NOT multipart — one part
//     would be one PUT with three extra requests around it — and everything
//     above it is. Off by one here, and a 9 MB clip spends four requests to
//     arrive, or an 8.1 MB one is sent as a single request it cannot survive.
//   * THE ORDER OF THE PARTS. `CompleteMultipartUpload` names the parts that
//     become the creator's video, and the bucket assembles them in the order
//     they are LISTED. Sent unsorted, a video's middle and end swap places and
//     nothing anywhere reports an error.
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  UPLOAD_PART_BYTES,
  completeMultipartBody,
  needsMultipart,
  partCountFor,
  videoObjectKey,
} from "@/lib/upload-target";

const MIB = 1024 * 1024;

describe("partCountFor", () => {
  it("counts a file that lands exactly on a boundary as that many parts", () => {
    expect(partCountFor(UPLOAD_PART_BYTES)).toBe(1);
    expect(partCountFor(2 * UPLOAD_PART_BYTES)).toBe(2);
  });

  it("gives the remainder its own part, so no tail is left behind", () => {
    expect(partCountFor(UPLOAD_PART_BYTES + 1)).toBe(2);
    // 2 GiB is exactly 256 parts, and ONE byte more is 257 — the sliver is what
    // a file sent without it would have had missing from its end. This is the
    // boundary the application's own limit sits on: MAX_VIDEO_BYTES is one byte
    // below 2 GiB, so the largest file Genhub accepts is exactly 256 parts.
    expect(partCountFor(2 * 1024 * MIB)).toBe(256);
    expect(partCountFor(2 * 1024 * MIB + 1)).toBe(257);
  });

  it("answers zero for a file with nothing in it rather than one empty part", () => {
    expect(partCountFor(0)).toBe(0);
    expect(partCountFor(-1)).toBe(0);
    expect(partCountFor(Number.NaN)).toBe(0);
    expect(partCountFor(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("needsMultipart", () => {
  it("keeps one part as one request", () => {
    expect(needsMultipart(UPLOAD_PART_BYTES)).toBe(false);
    expect(needsMultipart(1)).toBe(false);
  });

  it("splits anything that would not fit in one", () => {
    expect(needsMultipart(UPLOAD_PART_BYTES + 1)).toBe(true);
    expect(needsMultipart(200 * MIB)).toBe(true);
  });

  it("says no when the size is unknown, which is the size a client can omit", () => {
    // An upload-signature call with no `size` cannot be sized, and the simpler
    // transport is the one that existed before this — refusing the upload is not
    // an option when the file may be perfectly sendable in one request.
    expect(needsMultipart(Number.NaN)).toBe(false);
  });
});

describe("videoObjectKey", () => {
  it("is derived from the video id alone, so the client cannot choose its object", () => {
    expect(videoObjectKey("abc-123")).toBe("incoming/abc-123");
  });
});

describe("completeMultipartBody", () => {
  it("lists the parts in number order, whatever order they arrive in", () => {
    const body = completeMultipartBody([
      { partNumber: 3, etag: '"c"' },
      { partNumber: 1, etag: '"a"' },
      { partNumber: 2, etag: '"b"' },
    ]);

    expect(body).toBe(
      "<CompleteMultipartUpload>" +
        '<Part><PartNumber>1</PartNumber><ETag>"a"</ETag></Part>' +
        '<Part><PartNumber>2</PartNumber><ETag>"b"</ETag></Part>' +
        '<Part><PartNumber>3</PartNumber><ETag>"c"</ETag></Part>' +
        "</CompleteMultipartUpload>"
    );
  });

  it("keeps the quotes around an ETag, because the bucket matches them verbatim", () => {
    expect(completeMultipartBody([{ partNumber: 1, etag: '"abc"' }])).toContain("<ETag>\"abc\"</ETag>");
  });

  it("does not reorder the caller's own array", () => {
    const parts = [
      { partNumber: 2, etag: '"b"' },
      { partNumber: 1, etag: '"a"' },
    ];
    completeMultipartBody(parts);
    expect(parts.map((part) => part.partNumber)).toEqual([2, 1]);
  });
});
