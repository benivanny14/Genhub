// =============================================================================
// GENHUB - TUS direct upload
//
// The uploader replaced a single PUT that could never have worked: Bunny's
// management endpoint wants the `AccessKey` header, and a 401 with no body is a
// terrible thing to debug from a creator's phone. The checks below are the ones
// that fail BEFORE any bytes move, plus the metadata encoding, which is the part
// that silently corrupts non-ASCII titles.
// =============================================================================

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  adaptChunkSize,
  encodeUploadMetadata,
  initialChunkSize,
  uploadFileWithTus,
  TusUploadError,
  videoSizeError,
  DESKTOP_CHUNK_SIZE,
  FAST_CHUNK_SIZE,
  MAX_VIDEO_BYTES,
  MOBILE_CHUNK_SIZE,
  TUS_CHUNK_ALIGNMENT,
  UPLOAD_STALL_WARNING_MS,
} from "@/lib/tus-upload";

const credentials = {
  endpoint: "https://video.bunnycdn.com/tusupload",
  videoId: "vid-1",
  libraryId: "12345",
  expirationTime: Math.floor(Date.now() / 1000) + 3600,
  signature: "a".repeat(64),
};

const fileOf = (bytes: number, name = "scene.mp4") =>
  new File([new Uint8Array(bytes)], name, { type: "video/mp4" });

/** A File whose only real property is its size — 2 GB must not be allocated. */
const bigFileOf = (bytes: number) =>
  ({ size: bytes, type: "video/mp4", name: "scene.mp4" }) as unknown as File;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TUS direct upload", () => {
  it("refuses an expired authorization without sending anything", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const expired = { ...credentials, expirationTime: Math.floor(Date.now() / 1000) - 1 };

    await expect(uploadFileWithTus(fileOf(1024), expired)).rejects.toMatchObject({
      code: "EXPIRED",
    });
    await expect(uploadFileWithTus(fileOf(1024), expired)).rejects.toBeInstanceOf(
      TusUploadError
    );
    // The point of the check: no request, so no opaque 401 to interpret.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an empty file instead of reserving a slot for nothing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(uploadFileWithTus(fileOf(0), credentials)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a file over 2 GB before any bytes are sent", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      uploadFileWithTus(bigFileOf(MAX_VIDEO_BYTES + 1), credentials)
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the authorization headers TUS requires on the reserve call", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        // No Location => the uploader must fail loudly rather than guess.
        return new Response("", { status: 201 });
      })
    );

    await expect(
      uploadFileWithTus(fileOf(1024), credentials)
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://video.bunnycdn.com/tusupload");
    expect(calls[0].headers).toMatchObject({
      "Tus-Resumable": "1.0.0",
      "Upload-Length": "1024",
      AuthorizationSignature: credentials.signature,
      AuthorizationExpire: String(credentials.expirationTime),
      LibraryId: "12345",
      VideoId: "vid-1",
    });
  });

  it("re-sends the authorization headers on every PATCH", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        // Relative Location, exactly like Bunny answers.
        new Response("", { status: 201, headers: { Location: "/tusupload/abc" } })
      )
    );

    const patches: Array<Record<string, string>> = [];
    class FakeXhr {
      upload = { onprogress: null as unknown };
      status = 0;
      responseText = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      private headers: Record<string, string> = {};
      open() {}
      setRequestHeader(name: string, value: string) {
        this.headers[name] = value;
      }
      getResponseHeader(name: string) {
        return name === "Upload-Offset" ? "1024" : null;
      }
      abort() {}
      send() {
        patches.push({ ...this.headers });
        this.status = 204;
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr as unknown as typeof XMLHttpRequest);

    await uploadFileWithTus(fileOf(1024), credentials);

    expect(patches).toHaveLength(1);
    // Omitting these makes Bunny answer `400 Library ID missing or invalid.`
    expect(patches[0]).toMatchObject({
      "Tus-Resumable": "1.0.0",
      "Upload-Offset": "0",
      AuthorizationSignature: credentials.signature,
      AuthorizationExpire: String(credentials.expirationTime),
      LibraryId: "12345",
      VideoId: "vid-1",
    });
  });

  it("base64-encodes metadata values so non-ASCII titles survive", () => {
    const metadata = encodeUploadMetadata({
      filetype: "video/mp4",
      title: "Ngoma ya usiku — sehemu 2",
    });

    // Keys stay plain text; values are base64.
    expect(metadata.startsWith("filetype dmlkZW8vbXA0,title ")).toBe(true);

    const encodedTitle = metadata.split("title ")[1];
    expect(Buffer.from(encodedTitle, "base64").toString("utf8")).toBe(
      "Ngoma ya usiku — sehemu 2"
    );
    // A naive btoa(title) on this string throws; the encoder must not.
    expect(metadata).not.toMatch(/[\s,]=*$/);
  });
});

// =============================================================================
// Chunk sizing — the mobile half of the upload
//
// The old fixed 32 MiB was the single biggest reason an upload from a phone
// ended in a frozen bar: one lost signal anywhere in a 32 MiB chunk threw away
// minutes of transfer, and on a phone that is most of what a 300 MB file is.
// These pin the rules, including that every answer is a legal TUS chunk size.
// =============================================================================

describe("chunk sizing", () => {
  it("starts a phone smaller than a desktop", () => {
    const size = 500 * 1024 * 1024;
    expect(initialChunkSize(true, size)).toBe(MOBILE_CHUNK_SIZE);
    expect(initialChunkSize(false, size)).toBe(DESKTOP_CHUNK_SIZE);
    expect(MOBILE_CHUNK_SIZE).toBeLessThan(DESKTOP_CHUNK_SIZE);
  });

  it("never asks for a chunk larger than the file", () => {
    // A 1 MB file on a phone is one request, not two.
    expect(initialChunkSize(true, 1024 * 1024)).toBe(1024 * 1024);
  });

  it("always returns a multiple of 256 KiB, which the TUS spec requires", () => {
    for (const isMobile of [true, false]) {
      expect(initialChunkSize(isMobile, 500 * 1024 * 1024) % TUS_CHUNK_ALIGNMENT).toBe(0);
    }
    for (const rate of [1, 100_000, 500_000, 5_000_000, 50_000_000]) {
      expect(adaptChunkSize(DESKTOP_CHUNK_SIZE, rate) % TUS_CHUNK_ALIGNMENT).toBe(0);
    }
  });

  it("shrinks to the phone size on a genuinely slow connection", () => {
    // 250 KB/s: a 32 MiB chunk would be two minutes of work at risk.
    expect(adaptChunkSize(DESKTOP_CHUNK_SIZE, 250 * 1024)).toBe(MOBILE_CHUNK_SIZE);
  });

  it("grows back once the connection proves itself", () => {
    expect(adaptChunkSize(MOBILE_CHUNK_SIZE, 5 * 1024 * 1024)).toBe(FAST_CHUNK_SIZE);
  });

  it("leaves a middling connection alone instead of oscillating", () => {
    // Halfway between the two thresholds is where a size that is working is not
    // worth re-deciding every single chunk.
    expect(adaptChunkSize(DESKTOP_CHUNK_SIZE, 1024 * 1024)).toBe(DESKTOP_CHUNK_SIZE);
    expect(adaptChunkSize(MOBILE_CHUNK_SIZE, 1024 * 1024)).toBe(MOBILE_CHUNK_SIZE);
  });

  it("ignores a nonsense measurement rather than resizing on it", () => {
    expect(adaptChunkSize(DESKTOP_CHUNK_SIZE, 0)).toBe(DESKTOP_CHUNK_SIZE);
    expect(adaptChunkSize(DESKTOP_CHUNK_SIZE, Number.NaN)).toBe(DESKTOP_CHUNK_SIZE);
    expect(adaptChunkSize(DESKTOP_CHUNK_SIZE, -5)).toBe(DESKTOP_CHUNK_SIZE);
  });

  it("warns a creator before the transport gives up on a dead connection", () => {
    // The warning has to fire while the creator is still looking at the screen:
    // the whole point is that they can still do something about it.
    expect(UPLOAD_STALL_WARNING_MS).toBeGreaterThan(10_000);
    expect(UPLOAD_STALL_WARNING_MS).toBeLessThan(3 * 60 * 1000);
  });

  it("pins the chunk size when a caller supplies one", async () => {
    // Tests and any future caller that knows better must not have their size
    // rewritten mid-upload.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("", { status: 201, headers: { Location: "/tusupload/abc" } })
      )
    );

    const seen: number[] = [];
    class FakeXhr {
      upload = { onprogress: null as unknown };
      status = 0;
      responseText = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;
      private headers: Record<string, string> = {};
      open() {}
      setRequestHeader(name: string, value: string) {
        this.headers[name] = value;
      }
      getResponseHeader(name: string) {
        return name === "Upload-Offset" ? this.nextOffset : null;
      }
      abort() {}
      nextOffset = "0";
      send(blob: Blob) {
        seen.push(blob.size);
        this.nextOffset = String(Number(this.headers["Upload-Offset"]) + blob.size);
        this.status = 204;
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr as unknown as typeof XMLHttpRequest);

    await uploadFileWithTus(fileOf(TUS_CHUNK_ALIGNMENT * 3), credentials, {
      chunkSize: TUS_CHUNK_ALIGNMENT,
    });

    expect(seen).toEqual([
      TUS_CHUNK_ALIGNMENT,
      TUS_CHUNK_ALIGNMENT,
      TUS_CHUNK_ALIGNMENT,
    ]);
  });
});

describe("video size guard", () => {
  it("accepts a file right at the 2 GB limit", () => {
    expect(videoSizeError(bigFileOf(MAX_VIDEO_BYTES))).toBeNull();
  });

  it("names the size and the limit so the creator knows what to do", () => {
    const message = videoSizeError(bigFileOf(3 * 1024 * 1024 * 1024));
    expect(message).toMatch(/3\.00 GB/);
    expect(message).toMatch(/2 GB/);
  });
});
