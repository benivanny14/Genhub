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

import { join } from "path";
import { readFileSync } from "fs";
import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});
import { api } from "@/lib/api-response";
import {
  MULTIPART_UPLOAD_ID_RE,
  UPLOAD_PART_BYTES,
  completeMultipartBody,
  isMultipartUploadId,
  needsMultipart,
  originMayUpload,
  parseReportedSize,
  partCountFor,
  preflightAllowsOrigin,
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

  it("says no when the size is unknown, and the route never lets that happen", () => {
    // The predicate itself cannot size a NaN, so it says no — and that is why the
    // route REFUSES a request with no usable size rather than reaching here with
    // one (parseReportedSize, asserted below). Left to this fall-back, a request
    // that forgot its size was answered with the whole-file PUT: the transport
    // with no offset to resume from, handed out by accident on the one request
    // that was supposed to choose the one that survives a 3G connection.
    expect(needsMultipart(Number.NaN)).toBe(false);
  });

  it("splits at exactly one part and not at one byte less", () => {
    expect(needsMultipart(UPLOAD_PART_BYTES)).toBe(false);
    expect(needsMultipart(UPLOAD_PART_BYTES + 1)).toBe(true);
    // 8 MiB is the floor S3 requires of every part but the last, so a file that
    // lands exactly on it is one request and a file one byte over it is two.
    expect(UPLOAD_PART_BYTES).toBe(8 * MIB);
  });
});

describe("parseReportedSize", () => {
  it("accepts a real size, as a number or as the string a form sends", () => {
    expect(parseReportedSize(8 * MIB)).toEqual({ ok: true, size: 8 * MIB });
    expect(parseReportedSize("201291964")).toEqual({ ok: true, size: 201291964 });
    expect(parseReportedSize(1)).toEqual({ ok: true, size: 1 });
  });

  it("refuses everything that cannot decide a transport", () => {
    // Every one of these used to fall through to the whole-file PUT.
    for (const value of [undefined, null, "", "abc", {}, [], Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      const parsed = parseReportedSize(value);
      expect(parsed.ok, `expected ${JSON.stringify(value)} to be refused`).toBe(false);
      expect(parsed.ok === false && parsed.error.length).toBeGreaterThan(20);
    }
  });

  it("is consulted by the reserve route before a slot is reserved, with a 422", () => {
    // A refused request must not have created anything: a slot is a real object
    // in the Bunny library, and the size is checked before it exists.
    const route = readFileSync(
      join(process.cwd(), "src", "app", "api", "videos", "upload-signature", "route.ts"),
      "utf8"
    );

    const checked = route.indexOf("parseReportedSize(body.size)");
    const reserved = route.indexOf("await createVideoUpload(");
    const refusal = route.indexOf("return api.validation(reported.error)");

    expect(checked).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(-1);
    expect(reserved).toBeGreaterThan(-1);
    expect(checked).toBeLessThan(reserved);
    expect(refusal).toBeLessThan(reserved);
    // 422, the status api.validation answers with — not a 400 and not a 500.
    expect(api.validation("x").status).toBe(422);
  });
});

// =============================================================================
// THE UPLOAD ID, and the failure this rule caused.
//
// On 2026-09-29 the bucket was asked to BEGIN an upload and answered with an id
// of 343 characters. The rule in place allowed 300, so every part request of
// every file was refused by our own validation with HTTP 422 in 400 ms — before
// R2 was reached — and two creators' 192 MB uploads were recorded that way on 3G.
// These tests exist so the number can never be wrong in that direction again, and
// so the properties that ARE load-bearing (which the signer depends on) are
// pinned separately from it.
// =============================================================================
describe("the shape of an upload id from the storage service", () => {
  // The id measured live, 343 characters, with the observed prefix and suffix
  // kept and the random middle filled in.
  const PREFIX = "AB06FVTxjYGJnjFXLbFo3pN_A43jmN4hbssWSAO9BCxEcHclBP-TQ0UIgYMN";
  const SUFFIX = "mT41oFUhLHDpLBEaqPvU";
  const MEASURED_ID = PREFIX + "k".repeat(343 - PREFIX.length - SUFFIX.length) + SUFFIX;

  it("accepts the id the bucket actually issued — 343 characters, not 300", () => {
    expect(MEASURED_ID).toHaveLength(343);
    expect(isMultipartUploadId(MEASURED_ID)).toBe(true);
  });

  it("leaves room above the measured value, because that gap is the whole fix", () => {
    // A ceiling that sits near the value it bounds is a landmine: R2's ids are a
    // random blob, and a future one that is a byte longer must not refuse every
    // upload. 1024 is far above anything observed and still bounds the input.
    expect(isMultipartUploadId("A".repeat(1024))).toBe(true);
    expect(isMultipartUploadId("A".repeat(1025))).toBe(false);
  });

  it("refuses anything that could point a signed part at another object", () => {
    // The properties the signer depends on (lib/r2-sign.ts): the id is placed in
    // the query string, so a character that ends a parameter or starts a new one
    // would change the operation parameters the signature covers. These are the
    // ones that do that.
    for (const hostile of [
      "abc?partNumber=9",
      "abc&uploadId=x",
      "abc def",
      "abc\ndef",
      "abc#frag",
      "abc%2Fdef",
      "",
    ]) {
      expect(isMultipartUploadId(hostile), JSON.stringify(hostile)).toBe(false);
    }
  });

  it("keeps the whole base64 alphabet, including what base64 pads with", () => {
    // `/`, `+` and `=` are all standard base64, so refusing them would be the
    // same mistake in the other direction: assuming a shape the bucket was never
    // asked to produce. The measured id used `-` and `_` (base64url, unpadded),
    // and that is exactly why this test asserts the ALPHABET rather than the one
    // sample — the last time this rule guessed, it guessed the length.
    expect(isMultipartUploadId("abc/def+g=")).toBe(true);
    expect(isMultipartUploadId("abc=xyz")).toBe(true);
  });

  it("is defined in ONE place, with no route keeping a private copy", () => {
    // The three routes each used to declare this rule locally — three copies of
    // one invented bound, all three wrong together, which is why one fix had to
    // touch three files. The rule is asserted here rather than the behaviour,
    // because a copy that agrees today is a copy that disagrees later.
    const routes = [
      "src/app/api/videos/upload-part/route.ts",
      "src/app/api/videos/upload-complete/route.ts",
      "src/app/api/videos/upload-abort/route.ts",
    ];

    for (const route of routes) {
      const source = readFileSync(join(process.cwd(), route), "utf8");
      expect(source, route).toContain("MULTIPART_UPLOAD_ID_RE");
      // No local declaration of a regex for the upload id.
      expect(source, route).not.toMatch(/const UPLOAD_ID_RE\s*=/);
      expect(source, route).not.toMatch(/= \/\^\[A-Za-z0-9/);
    }

    expect(MULTIPART_UPLOAD_ID_RE.test(MEASURED_ID)).toBe(true);
  });
});

// =============================================================================
// The bucket's answer about the page a creator is uploading from.
//
// The failure this exists to stop, measured on 2026-09-29: the bucket's CORS
// policy named two origins, a creator's page was served from a third, and the
// browser therefore never sent the PUT — the page saw a request that failed in
// about a second with ZERO bytes moved, four times, and could only say "the
// connection dropped during upload", which is the same sentence a phone with no
// signal produces. Nothing in the record could tell them apart.
// =============================================================================
describe("the bucket's answer about a page's address", () => {
  const preflight = (status: number, allowOrigin: string | null) => ({
    status,
    headers: { get: (name: string) => (name === "access-control-allow-origin" ? allowOrigin : null) },
  });

  it("accepts only the origin it names", () => {
    expect(preflightAllowsOrigin(preflight(204, "https://genhub-two.vercel.app"), "https://genhub-two.vercel.app")).toBe(true);
    // A policy that names somebody else is a refusal for this page, not a pass.
    expect(preflightAllowsOrigin(preflight(204, "https://genhub-two.vercel.app"), "https://genhub.co.tz")).toBe(false);
  });

  it("treats a wildcard policy as a pass", () => {
    expect(preflightAllowsOrigin(preflight(204, "*"), "https://anything.example")).toBe(true);
  });

  it("is a refusal when the bucket refuses, however it words it", () => {
    // Measured: an origin outside the policy is answered 403 with no
    // allow-origin header at all. Both halves are checked, because either one
    // alone can be right while the other is wrong.
    expect(preflightAllowsOrigin(preflight(403, null), "https://genhub.co.tz")).toBe(false);
    expect(preflightAllowsOrigin(preflight(200, null), "https://genhub.co.tz")).toBe(false);
  });

  it("asks the bucket nothing when the page is not a browser at all", async () => {
    const ask = vi.fn();
    vi.stubGlobal("fetch", ask);

    // No Origin header means no browser: a server-side or scripted caller has no
    // page to be refused on, and refusing it would break every non-browser path.
    await expect(originMayUpload("")).resolves.toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("is consulted by the reserve route BEFORE a slot is reserved", () => {
    // Order matters in both directions. Before, because a slot is a real object
    // in the Bunny library and one created for an upload that cannot happen is
    // the orphan this codebase has already cleaned up once. Checked at all,
    // because the reservation is the last moment the creator can be told the
    // truth before their data is spent.
    const route = readFileSync(
      join(process.cwd(), "src", "app", "api", "videos", "upload-signature", "route.ts"),
      "utf8"
    );

    // `await` on both, because the import statements mention the same names and
    // an earlier version of this test compared the CALL against an IMPORT.
    const checked = route.indexOf("await originMayUpload(");
    const reserved = route.indexOf("await createVideoUpload(");

    expect(checked).toBeGreaterThan(-1);
    expect(reserved).toBeGreaterThan(-1);
    expect(checked).toBeLessThan(reserved);
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
