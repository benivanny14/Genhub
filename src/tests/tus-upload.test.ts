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
import { encodeUploadMetadata, uploadFileWithTus, TusUploadError } from "@/lib/tus-upload";

const credentials = {
  endpoint: "https://video.bunnycdn.com/tusupload",
  videoId: "vid-1",
  libraryId: "12345",
  expirationTime: Math.floor(Date.now() / 1000) + 3600,
  signature: "a".repeat(64),
};

const fileOf = (bytes: number, name = "scene.mp4") =>
  new File([new Uint8Array(bytes)], name, { type: "video/mp4" });

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
