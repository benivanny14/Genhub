import { describe, expect, it, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  cancelTusUpload,
  createTusUpload,
  patchTusChunk,
  tusAuthHeaders,
} from "@/lib/bunny-tus";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("direct Bunny TUS transport", () => {
  it("creates the exact signed headers Bunny requires", async () => {
    const headers = await tusAuthHeaders({
      libraryId: "lib-1",
      apiKey: "key-1",
      videoId: "video-1",
      expiresAt: 1_700_000_000,
    });

    const expected = createHash("sha256")
      .update("lib-1key-11700000000video-1")
      .digest("hex");

    expect(headers).toEqual({
      AuthorizationSignature: expected,
      AuthorizationExpire: "1700000000",
      LibraryId: "lib-1",
      VideoId: "video-1",
    });
  });

  it("resolves Bunny's relative TUS location", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(null, {
        status: 201,
        headers: { Location: "/tusupload/session-1" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createTusUpload({
      libraryId: "lib-1",
      apiKey: "key-1",
      videoId: "video-1",
      total: 12,
      expiresAt: 1_700_000_000,
    });

    expect(result).toEqual({
      ok: true,
      uploadUrl: "https://video.bunnycdn.com/tusupload/session-1",
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe("POST");
    expect((request.headers as Record<string, string>)["Upload-Length"]).toBe("12");
    expect((request.headers as Record<string, string>)["Tus-Resumable"]).toBe("1.0.0");
  });

  it("uses Bunny's acknowledged offset and supports abort cleanup", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 204, headers: { "upload-offset": "4" } })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const headers = { LibraryId: "lib-1", VideoId: "video-1" };
    const sent = await patchTusChunk({
      uploadUrl: "https://video.bunnycdn.com/tusupload/session-1",
      headers,
      offset: 0,
      body: new Uint8Array([1, 2, 3, 4]),
      size: 4,
    });
    await cancelTusUpload({
      uploadUrl: "https://video.bunnycdn.com/tusupload/session-1",
      headers,
    });

    expect(sent).toEqual({ ok: true, offset: 4 });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "PATCH" });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
  });
});
