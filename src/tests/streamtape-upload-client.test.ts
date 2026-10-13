import { afterEach, describe, expect, it, vi } from "vitest";
import {
  importAndWaitForStreamtape,
  parseStreamtapeUploadSession,
  StreamtapeUploadNotStagedError,
  uploadVideoToStaging,
} from "@/lib/streamtape-upload-client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function sessionPayload() {
  return {
    provider: "STREAMTAPE",
    sessionToken: "s".repeat(100),
    videoId: "upload-1",
    uploadUrl: "https://r2.example.test/signed-upload",
    headers: { "Content-Type": "video/mp4" },
    totalBytes: 3,
    mimeType: "video/mp4",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

describe("Streamtape browser uploads", () => {
  it("accepts only a well-formed HTTPS Streamtape staging session", () => {
    expect(parseStreamtapeUploadSession(sessionPayload()).provider).toBe("STREAMTAPE");
    expect(() =>
      parseStreamtapeUploadSession({ ...sessionPayload(), uploadUrl: "http://r2.example.test/file" })
    ).toThrow("The upload session could not be started.");
    expect(() =>
      parseStreamtapeUploadSession({ ...sessionPayload(), provider: "BUNNY" })
    ).toThrow("The upload session could not be started.");
  });

  it("sends the file to the signed staging URL and reports byte progress", async () => {
    const requests: FakeXHR[] = [];
    class FakeXHR {
      upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      onload: (() => void) | null = null;
      status = 200;
      responseText = "";
      method = "";
      url = "";
      headers: Record<string, string> = {};
      body: File | null = null;

      constructor() {
        requests.push(this);
      }

      open(method: string, url: string) {
        this.method = method;
        this.url = url;
      }

      setRequestHeader(name: string, value: string) {
        this.headers[name] = value;
      }

      send(body: File) {
        this.body = body;
        this.upload.onprogress?.({ loaded: body.size } as ProgressEvent);
        this.onload?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXHR);

    const progress = vi.fn();
    const file = new File(["abc"], "clip.mp4", { type: "video/mp4" });
    const uploadSession = parseStreamtapeUploadSession(sessionPayload());
    await uploadVideoToStaging(file, uploadSession, progress);

    expect(requests[0]?.method).toBe("PUT");
    expect(requests[0]?.url).toBe(uploadSession.uploadUrl);
    expect(requests[0]?.headers["Content-Type"]).toBe("video/mp4");
    expect(requests[0]?.body).toBe(file);
    expect(progress).toHaveBeenLastCalledWith({
      uploadedBytes: file.size,
      totalBytes: file.size,
      percent: 100,
    });
  });

  it("waits for a READY import and returns its Streamtape file id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: { state: "IMPORTING" } }))
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: { state: "READY", fileId: "st_file_123", progress: 100 },
          })
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(importAndWaitForStreamtape("s".repeat(100))).resolves.toBe("st_file_123");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/videos/upload-complete",
      "/api/videos/upload-status",
    ]);
  });

  it("retries temporary status failures without abandoning the import", async () => {
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void) => {
        callback();
        return 0;
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: { state: "IMPORTING" } }))
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false, error: "Provider temporarily unavailable" }), {
          status: 503,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: { state: "IMPORTING" } }))
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: { state: "READY", fileId: "st_file_123", progress: 100 },
          })
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(importAndWaitForStreamtape("s".repeat(100))).resolves.toBe("st_file_123");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("surfaces a failed provider import instead of reporting upload success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: { state: "IMPORTING" } }))
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: { state: "FAILED", progress: 0 } }))
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(importAndWaitForStreamtape("s".repeat(100))).rejects.toThrow(
      "The video could not be processed. Upload it again."
    );
  });

  it("identifies an unstaged file so Resume can retry the byte transfer", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          code: "UPLOAD_INCOMPLETE",
          error: "The upload is not complete yet. Continue uploading and try again.",
        }),
        { status: 409 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(importAndWaitForStreamtape("s".repeat(100))).rejects.toBeInstanceOf(
      StreamtapeUploadNotStagedError
    );
  });

  it("marks a provider-declared failed import as terminal", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: { state: "IMPORTING" } }))
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: { state: "FAILED", progress: 0 } }))
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(importAndWaitForStreamtape("s".repeat(100))).rejects.toMatchObject({
      name: "StreamtapeImportFailedError",
    });
  });
});
