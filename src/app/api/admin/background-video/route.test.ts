// =============================================================================
// GENHUB - /api/admin/background-video
//
// The button that puts a clip behind the whole interface, and everything it
// refuses to do. What is pinned here:
//
//   1. NOTHING IS SIGNED OR STORED UNTIL THE REQUEST IS GOOD. The whole point of
//      this route is that no byte of the clip passes through it — the browser
//      PUTs the file straight to R2 against a URL signed here — so a refusal must
//      leave no object, no setting and no session behind it.
//   2. The ceiling is answered from the size the client declared, before a single
//      byte moves, and the sentence names the same limit the picker used.
//   3. The MIME type and the filename are CLAIMS, resolved against the one
//      allowlist; a container we cannot play is refused before anything is signed.
//   4. Nothing becomes VISIBLE here. Opening an upload only hands back a signed
//      destination — the settings row is written by /complete, and only after R2
//      confirms what it actually holds.
//   5. Taking it down clears the row FIRST and deletes the object second, so an
//      interrupted delete leaves an unreachable object rather than a page
//      pointing at a clip that is not there.
//
// Auth, rate limiting, the audit log, the settings service and the R2/S3 client
// are all mocked. This suite writes nothing anywhere and reaches nothing.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getBackgroundVideo: vi.fn(),
  setSetting: vi.fn(),
  checkRateLimit: vi.fn(),
  audit: vi.fn(),
  requireRole: vi.fn(),
  configured: vi.fn(),
  startUpload: vi.fn(),
  keyFor: vi.fn(),
  removeObject: vi.fn(),
}));

vi.mock("@/lib/services/platform-setting.service", () => ({
  PLATFORM_SETTING_KEYS: { backgroundVideo: "site.background_video" },
  getBackgroundVideo: mocks.getBackgroundVideo,
  setSetting: mocks.setSetting,
}));

vi.mock("@/lib/background-video-session", () => ({
  isBackgroundVideoUploadConfigured: mocks.configured,
  startBackgroundVideoUpload: mocks.startUpload,
}));

vi.mock("@/lib/r2", () => ({
  r2BackgroundKeyFor: mocks.keyFor,
  r2DeleteObject: mocks.removeObject,
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

import { GET, POST, DELETE } from "./route";
// The route answers with `instanceof AuthError`, so the rejection has to be an
// instance of the SAME class it imports — the mocked one.
import { AuthError } from "@/lib/auth";
import { MAX_BACKGROUND_VIDEO_BYTES } from "@/lib/background-video";

const URL = "http://localhost/api/admin/background-video";
const NO_CLIP = { active: false, token: "", mimeType: "", name: "", size: 0 };
const ACTIVE = {
  active: true,
  token: "ffffffffffffffffffffffff",
  mimeType: "video/mp4",
  name: "old.mp4",
  size: 1024,
};
const OLD_KEY = "site/background/ffffffffffffffffffffffff.mp4";

/** A starting request, as the admin client sends it: JSON, small. */
function start(
  body: unknown,
  options: { raw?: string } = {}
): Promise<Response> {
  return POST(
    new NextRequest(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: options.raw ?? JSON.stringify(body),
    })
  );
}

function good(overrides: Record<string, unknown> = {}) {
  return { name: "hero.mp4", mimeType: "video/mp4", size: 1024, ...overrides };
}

/** What the route asked the signer to open, if it asked at all. */
function signedWith() {
  return mocks.startUpload.mock.calls[0]?.[0];
}

describe("POST /api/admin/background-video", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({ userId: "admin-1", role: "ADMIN" });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });
    mocks.getBackgroundVideo.mockResolvedValue(NO_CLIP);
    mocks.setSetting.mockResolvedValue(undefined);
    mocks.audit.mockResolvedValue(undefined);
    mocks.configured.mockReturnValue(true);
    mocks.keyFor.mockReturnValue(OLD_KEY);
    mocks.removeObject.mockResolvedValue(undefined);
    mocks.startUpload.mockImplementation(async (params: { token: string; mimeType: string }) => ({
      sessionToken: "signed.session.token",
      token: params.token,
      key: `site/background/${params.token}.mp4`,
      mimeType: params.mimeType,
      name: "hero.mp4",
      size: 1024,
      uploadUrl: `https://acct.r2.cloudflarestorage.com/genhub-uploads/site/background/${params.token}.mp4?sig`,
      headers: { "content-type": params.mimeType },
      expiresAt: 1_800_000_000,
    }));
  });

  it("refuses anyone who is not an admin, and signs nothing", async () => {
    mocks.requireRole.mockRejectedValue(new AuthError("Authentication required", 401));

    const response = await start(good());

    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("UNAUTHORIZED");
    expect(mocks.startUpload).not.toHaveBeenCalled();
  });

  it("rate-limits an operator who is replacing it too often", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });

    const response = await start(good());

    expect(response.status).toBe(429);
    expect((await response.json()).code).toBe("RATE_LIMITED");
    expect(mocks.startUpload).not.toHaveBeenCalled();
  });

  // The operator is told only that it is not working: naming which variable is
  // missing to whoever asks is free reconnaissance.
  it("says storage is not configured without naming what is missing", async () => {
    mocks.configured.mockReturnValue(false);

    const response = await start(good());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.code).toBe("STORAGE_NOT_CONFIGURED");
    expect(JSON.stringify(body)).not.toContain("R2_");
    expect(mocks.startUpload).not.toHaveBeenCalled();
  });

  it("refuses a body it cannot read", async () => {
    const response = await start(null, { raw: "this is not json" });

    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("VALIDATION_ERROR");
    expect(mocks.startUpload).not.toHaveBeenCalled();
  });

  it("refuses a size that is not a positive number", async () => {
    const response = await start({ mimeType: "video/mp4", size: 0 });

    expect(response.status).toBe(422);
    expect(mocks.startUpload).not.toHaveBeenCalled();
  });

  it("refuses a file over the ceiling, naming the same limit the picker did", async () => {
    const response = await start(good({ size: MAX_BACKGROUND_VIDEO_BYTES + 1 }));
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body.code).toBe("FILE_TOO_LARGE");
    expect(body.error).toContain("500 MB");
    expect(mocks.startUpload).not.toHaveBeenCalled();
  });

  it("refuses a container it cannot play, before signing anything", async () => {
    const response = await start(good({ name: "clip.avi", mimeType: "video/x-msvideo" }));

    expect(response.status).toBe(422);
    expect(mocks.startUpload).not.toHaveBeenCalled();
  });

  // The whole point of the route: it hands back a destination and NOTHING is
  // live yet. The row is written by /complete, and only after R2 confirms the
  // object is really there.
  it("opens an upload and hands back a signed destination, without making it live", async () => {
    const response = await start(good());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toBe("Upload started");

    const upload = body.data.upload;
    expect(upload.sessionToken).toBe("signed.session.token");
    expect(upload.token).toMatch(/^[0-9a-f]{24}$/);
    expect(upload.uploadUrl).toContain("r2.cloudflarestorage.com");
    expect(upload.headers).toEqual({ "content-type": "video/mp4" });
    expect(upload.expiresAt).toBeGreaterThan(0);

    // The server decided the key, from ITS OWN token and allowlisted type.
    const asked = signedWith();
    expect(asked.userId).toBe("admin-1");
    expect(asked.token).toMatch(/^[0-9a-f]{24}$/);
    expect(asked.token).toBe(upload.token);
    expect(asked.mimeType).toBe("video/mp4");
    expect(asked.size).toBe(1024);

    // Nothing is stored, and nobody is told anything happened.
    expect(mocks.setSetting).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  // The MIME type is empty for a good number of files dragged off a file
  // manager; the extension is the fallback, and the type it resolves to is what
  // the object is signed as.
  it("resolves the type from the extension when the browser had no opinion", async () => {
    await start({ name: "clip.mkv", mimeType: "", size: 2048 });

    const asked = signedWith();
    expect(asked.mimeType).toBe("video/x-matroska");
    expect(asked.name).toBe("clip.mkv");
  });

  it("names the clip after its extension when the browser sent no filename", async () => {
    await start({ mimeType: "video/webm", size: 2048 });

    expect(signedWith().name).toBe("background.webm");
  });

  it("answers a failure to sign as a failure of ours, not of the file", async () => {
    mocks.startUpload.mockRejectedValue(new Error("R2 is not configured"));

    const response = await start(good());

    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe("UPLOAD_SESSION_FAILED");
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/background-video", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({ userId: "admin-1", role: "ADMIN" });
    mocks.getBackgroundVideo.mockResolvedValue(ACTIVE);
  });

  it("answers with what is set right now", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect((await response.json()).data.backgroundVideo).toEqual(ACTIVE);
  });

  it("refuses anyone who is not an admin", async () => {
    mocks.requireRole.mockRejectedValue(new AuthError("Admins only", 403));

    const response = await GET();

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("FORBIDDEN");
  });
});

describe("DELETE /api/admin/background-video", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({ userId: "admin-1", role: "ADMIN" });
    mocks.getBackgroundVideo.mockResolvedValue(NO_CLIP);
    mocks.setSetting.mockResolvedValue(undefined);
    mocks.audit.mockResolvedValue(undefined);
    mocks.keyFor.mockReturnValue(OLD_KEY);
    mocks.removeObject.mockResolvedValue(undefined);
  });

  it("clears the row first, then deletes the object, and says who did it", async () => {
    mocks.getBackgroundVideo.mockResolvedValue(ACTIVE);

    const response = await DELETE();

    expect(response.status).toBe(200);
    const [key, value, actor] = mocks.setSetting.mock.calls[0];
    expect(key).toBe("site.background_video");
    expect(JSON.parse(value as string)).toMatchObject({ active: false });
    expect(actor).toBe("admin-1");

    expect(mocks.keyFor).toHaveBeenCalledWith(ACTIVE.token, ACTIVE.mimeType);
    expect(mocks.removeObject).toHaveBeenCalledWith(OLD_KEY);
    // The row goes FIRST: an interrupted delete leaves an object nothing can
    // reach rather than a page pointing at a clip that is no longer there.
    expect(mocks.setSetting.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeObject.mock.invocationCallOrder[0]
    );

    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });

  it("does nothing to storage when there was no clip set", async () => {
    await DELETE();

    expect(mocks.setSetting).toHaveBeenCalledTimes(1);
    expect(mocks.keyFor).not.toHaveBeenCalled();
    expect(mocks.removeObject).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  // A row we would not have written names no object, so it must not become a
  // request to the bucket.
  it("does not reach the bucket for a row this app would not have written", async () => {
    mocks.getBackgroundVideo.mockResolvedValue({
      ...ACTIVE,
      token: "../../etc/passwd",
    });
    mocks.keyFor.mockReturnValue(null);

    await DELETE();

    expect(mocks.removeObject).not.toHaveBeenCalled();
  });

  it("keeps the object when the row could not be cleared", async () => {
    mocks.getBackgroundVideo.mockResolvedValue(ACTIVE);
    mocks.setSetting.mockRejectedValue(new Error("database is down"));

    const response = await DELETE();

    expect(response.status).toBe(500);
    expect(mocks.removeObject).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("refuses anyone who is not an admin", async () => {
    mocks.requireRole.mockRejectedValue(new AuthError("Authentication required", 401));

    const response = await DELETE();

    expect(response.status).toBe(401);
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });
});
