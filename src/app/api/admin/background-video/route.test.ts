// =============================================================================
// GENHUB - /api/admin/background-video
//
// The button that puts a clip behind the whole interface. What is pinned here:
//
//   1. NOTHING IS STORED UNTIL THE BYTES ARE KNOWN GOOD. The clip is read into a
//      bounded buffer, checked against the container's own magic, and only then
//      written. A rejection returns from inside the `try`, so every refusal has
//      to be checked for "and nothing was saved" — the fault this route shipped
//      with once, when a refused upload left a staging file on disk forever.
//   2. The ceiling is answered BEFORE the bytes arrive, from the size the client
//      declared, and again by the counter while they arrive.
//   3. The MIME type is a claim; the bytes decide.
//   4. A replacement removes the clip it replaced, and only after the new one is
//      safe — a failed write must never leave the site with no backdrop.
//
// Auth, rate limiting, the audit log, the settings service and the storage
// service are all mocked. This suite writes nothing anywhere.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getBackgroundVideo: vi.fn(),
  setSetting: vi.fn(),
  checkRateLimit: vi.fn(),
  audit: vi.fn(),
  requireRole: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/services/platform-setting.service", () => ({
  PLATFORM_SETTING_KEYS: { backgroundVideo: "site.background_video" },
  getBackgroundVideo: mocks.getBackgroundVideo,
  setSetting: mocks.setSetting,
}));

vi.mock("@/lib/services/background-video.service", () => ({
  saveBackgroundVideoAsset: mocks.save,
  deleteBackgroundVideoAsset: mocks.remove,
}));

vi.mock("@/lib/redis", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));

vi.mock("@/lib/services/audit.service", () => ({
  AUDIT_ACTIONS: { featureToggle: "feature.toggle" },
  recordAudit: mocks.audit,
}));

vi.mock("@/lib/auth", () => ({
  requireRole: mocks.requireRole,
  AuthError: class AuthError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number = 401) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

import { POST } from "./route";
// The route answers with `instanceof AuthError`, so the rejection has to be an
// instance of the SAME class it imports — the mocked one.
import { AuthError } from "@/lib/auth";
import { MAX_BACKGROUND_VIDEO_BYTES } from "@/lib/background-video";

/** 4 bytes of box length then `ftyp` — the marker this route looks for. */
const MP4 = Uint8Array.from([
  0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x32,
]);

const NO_CLIP = { active: false, token: "", mimeType: "", name: "", size: 0 };

function upload(
  body: BodyInit,
  headers: Record<string, string> = {}
): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/api/admin/background-video", {
      method: "POST",
      headers: { "content-type": "video/mp4", "x-filename": "clip.mp4", ...headers },
      body,
    })
  );
}

/** What the route asked the storage service to keep, if it asked at all. */
function storedToken(): string | null {
  const call = mocks.save.mock.calls[0];
  return call ? (call[0] as { id: string }).id : null;
}

describe("POST /api/admin/background-video", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({ userId: "admin-1", role: "ADMIN" });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });
    mocks.getBackgroundVideo.mockResolvedValue(NO_CLIP);
    mocks.setSetting.mockResolvedValue(undefined);
    mocks.audit.mockResolvedValue(undefined);
    mocks.save.mockResolvedValue(undefined);
    mocks.remove.mockResolvedValue(undefined);
  });

  it("refuses anyone who is not an admin", async () => {
    mocks.requireRole.mockRejectedValue(new AuthError("Authentication required", 401));

    const response = await upload(MP4);

    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("UNAUTHORIZED");
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it("rate-limits an operator who is replacing it too often", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });

    const response = await upload(MP4);

    expect(response.status).toBe(429);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it("refuses a container it cannot play, before storing anything", async () => {
    const response = await upload(MP4, {
      "content-type": "video/x-msvideo",
      "x-filename": "clip.avi",
    });

    expect(response.status).toBe(422);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it("refuses a file over the ceiling from the size the client declared", async () => {
    const response = await upload(MP4, { "x-file-size": "900000000" });

    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe("FILE_TOO_LARGE");
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it("refuses on the content-length the browser sends, without reading the body", async () => {
    const response = await upload(MP4, { "content-length": "900000000" });

    expect(response.status).toBe(413);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  // A declared length is a CLAIM. The counter is what actually bounds the read,
  // and it is the reason a client that lies about its size cannot make this route
  // buffer whatever it likes.
  it("refuses an undeclared body that grows past the ceiling while it arrives", async () => {
    const response = await upload(Buffer.alloc(MAX_BACKGROUND_VIDEO_BYTES + 1));

    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe("FILE_TOO_LARGE");
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  // The regression: a refusal returns from inside the `try`, so the check that
  // nothing was stored has to be made on every rejection path, not just in the
  // one that throws.
  it("stores nothing when the bytes are not a video", async () => {
    const response = await upload(new TextEncoder().encode("hello, not a video"));

    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("VALIDATION_ERROR");
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it("stores nothing for an empty body", async () => {
    const response = await upload(new Uint8Array(0));

    expect(response.status).toBe(422);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("stores a real clip, records the row and audits who did it", async () => {
    const response = await upload(MP4);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.backgroundVideo.active).toBe(true);
    expect(body.data.backgroundVideo.mimeType).toBe("video/mp4");
    expect(body.data.backgroundVideo.size).toBe(MP4.length);

    // The bytes that were validated are the bytes that were stored, under the
    // token the row now names.
    expect(mocks.save).toHaveBeenCalledTimes(1);
    const saved = mocks.save.mock.calls[0][0] as {
      id: string;
      mimeType: string;
      name: string;
      data: Uint8Array;
    };
    expect(saved.id).toMatch(/^[0-9a-f]{24}$/);
    expect(saved.mimeType).toBe("video/mp4");
    expect(saved.name).toBe("clip.mp4");
    expect(Array.from(saved.data)).toEqual(Array.from(MP4));

    expect(mocks.setSetting).toHaveBeenCalledTimes(1);
    const [key, value, actor] = mocks.setSetting.mock.calls[0];
    expect(key).toBe("site.background_video");
    expect(JSON.parse(value as string)).toMatchObject({
      active: true,
      token: saved.id,
      mimeType: "video/mp4",
      size: MP4.length,
    });
    expect(actor).toBe("admin-1");

    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });

  it("replaces the previous clip only once the new one is in place", async () => {
    const previous = {
      active: true,
      token: "ffffffffffffffffffffffff",
      mimeType: "video/mp4",
      name: "old.mp4",
      size: 1024,
    };
    mocks.getBackgroundVideo.mockResolvedValue(previous);

    const response = await upload(MP4);

    expect(response.status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith(previous.token);
    // Removed after the write, never before: deleting first would leave the site
    // with no backdrop if the store then failed.
    expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.remove.mock.invocationCallOrder[0]
    );
  });

  it("keeps the old clip when the new one cannot be stored", async () => {
    mocks.getBackgroundVideo.mockResolvedValue({
      active: true,
      token: "ffffffffffffffffffffffff",
      mimeType: "video/mp4",
      name: "old.mp4",
      size: 1024,
    });
    mocks.save.mockRejectedValue(new Error("database is down"));

    const response = await upload(MP4);

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("STORAGE_NOT_CONFIGURED");
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it("removes the clip it just stored when the setting cannot be written", async () => {
    mocks.setSetting.mockRejectedValue(new Error("database is down"));

    const response = await upload(MP4);

    expect(response.status).toBe(500);
    // Otherwise the bytes are an orphan nothing will ever serve or clean up.
    expect(mocks.remove).toHaveBeenCalledWith(storedToken());
  });
});
