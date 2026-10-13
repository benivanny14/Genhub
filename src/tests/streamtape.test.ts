import { afterEach, describe, expect, it, vi } from "vitest";
import { createVideoSchema } from "@/lib/validation";

function apiResponse(result: unknown) {
  return new Response(JSON.stringify({ status: 200, msg: "OK", result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Streamtape integration", () => {
  it("builds embeds only for a validated Streamtape file ID", async () => {
    vi.resetModules();
    const { streamtapeEmbedUrl } = await import("@/lib/streamtape");
    expect(streamtapeEmbedUrl("file_123-abc")).toBe("https://streamtape.com/e/file_123-abc");
    expect(streamtapeEmbedUrl("https://attacker.example/file")).toBeNull();
  });

  it("waits for both remote import and video conversion before marking ready", async () => {
    vi.stubEnv("STREAMTAPE_LOGIN", "test-login");
    vi.stubEnv("STREAMTAPE_API_KEY", "test-api-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(apiResponse({
        remote_123: { status: "finished", extid: "file_123", bytes_loaded: 10, bytes_total: 10 },
      }))
      .mockResolvedValueOnce(apiResponse({
        file_123: { id: "file_123", converted: true, status: 200 },
      }));
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();

    const { getStreamtapeUploadStatus } = await import("@/lib/streamtape");
    await expect(getStreamtapeUploadStatus("remote_123")).resolves.toEqual({
      state: "READY",
      fileId: "file_123",
      progress: 100,
    });

    const firstRequest = new URL(fetchMock.mock.calls[0][0] as string);
    expect(firstRequest.pathname).toBe("/remotedl/status");
    expect(firstRequest.searchParams.get("key")).toBe("test-api-key");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses video posts that do not prove exactly one provider upload", () => {
    const base = { title: "A scene", price: 500, complianceAttested: true };
    expect(createVideoSchema.safeParse({ ...base, bunnyVideoId: "legacy-guid" }).success).toBe(false);
    expect(
      createVideoSchema.safeParse({
        ...base,
        streamtapeFileId: "file_123",
        uploadSessionToken: "x".repeat(80),
      }).success
    ).toBe(true);
    expect(createVideoSchema.safeParse(base).success).toBe(false);
    expect(createVideoSchema.safeParse({
      ...base,
      streamtapeFileId: "file_123",
    }).success).toBe(false);
  });
});
