// =============================================================================
// GENHUB - /api/admin/background-video/complete
//
// The second half of the transport: the browser says it has finished sending the
// clip to R2, and this is where the claim is checked before the site believes it.
// What is pinned here:
//
//   1. THE CLAIM IS NOT THE EVIDENCE. The size that becomes the row comes from
//      R2's own answer to a HEAD, never from the number the client sent — a PUT
//      that died at 90% must not be recorded as live.
//   2. The session has to be one THIS server issued, to THIS admin. Otherwise
//      "make this token live" would be an instruction any caller could give.
//   3. THE OLD CLIP GOES LAST. It is deleted only after the new row is written,
//      so a failed write never leaves the site with no backdrop.
//   4. A missing object is a 409 that tells the operator to press Upload again,
//      not a 500 — the client still holds a valid signed URL for that key.
//
// Auth, rate limiting, the audit log, the settings service and the storage
// service are all mocked. This suite writes nothing anywhere and reaches nothing.
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
  verify: vi.fn(),
  head: vi.fn(),
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
  verifyBackgroundVideoUpload: mocks.verify,
}));

vi.mock("@/lib/r2", () => ({
  r2BackgroundKeyFor: mocks.keyFor,
  r2DeleteObject: mocks.removeObject,
  r2HeadObject: mocks.head,
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
import { AuthError } from "@/lib/auth";

const URL = "http://localhost/api/admin/background-video/complete";
const SESSION = "a.signed.session.token";
const TOKEN = "0123456789abcdef01234567";
const KEY = `site/background/${TOKEN}.mp4`;

const UPLOAD = {
  token: TOKEN,
  key: KEY,
  mimeType: "video/mp4",
  name: "hero.mp4",
  // What the CLIENT claimed. The route must not record this number.
  size: 9_999,
};

const NO_CLIP = { active: false, token: "", mimeType: "", name: "", size: 0 };

function confirm(body: unknown = { sessionToken: SESSION }): Promise<Response> {
  return POST(
    new NextRequest(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("POST /api/admin/background-video/complete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({ userId: "admin-1", role: "ADMIN" });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 19 });
    mocks.getBackgroundVideo.mockResolvedValue(NO_CLIP);
    mocks.setSetting.mockResolvedValue(undefined);
    mocks.audit.mockResolvedValue(undefined);
    mocks.configured.mockReturnValue(true);
    mocks.verify.mockResolvedValue({ ...UPLOAD });
    mocks.head.mockResolvedValue({ size: 4_096 });
    mocks.keyFor.mockReturnValue(`site/background/ffffffffffffffffffffffff.mp4`);
    mocks.removeObject.mockResolvedValue(undefined);
  });

  it("refuses anyone who is not an admin, and makes nothing live", async () => {
    mocks.requireRole.mockRejectedValue(new AuthError("Authentication required", 401));

    const response = await confirm();

    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("UNAUTHORIZED");
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it("rate-limits an operator who is retrying too often", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });

    const response = await confirm();

    expect(response.status).toBe(429);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("says storage is not configured rather than reading the session", async () => {
    mocks.configured.mockReturnValue(false);

    const response = await confirm();

    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("STORAGE_NOT_CONFIGURED");
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("refuses a session token it cannot even read", async () => {
    const response = await confirm({ sessionToken: "short" });

    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("VALIDATION_ERROR");
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  // Expired, tampered with, or issued to somebody else: nothing about which of
  // those it was belongs in the response, and none of them may reach the bucket.
  it("409s a session that is not one this server issued", async () => {
    mocks.verify.mockResolvedValue(null);

    const response = await confirm();

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("UPLOAD_SESSION_INVALID");
    expect(mocks.head).not.toHaveBeenCalled();
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it("checks the session against the admin who is asking", async () => {
    await confirm();

    expect(mocks.verify).toHaveBeenCalledWith(SESSION, "admin-1");
  });

  // The PUT could have been refused halfway, and recording it as live would put
  // a clip behind every page that plays nothing at all.
  it("409s, and records nothing, when the bucket holds no such object", async () => {
    mocks.head.mockResolvedValue(null);

    const response = await confirm();

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe("UPLOAD_NOT_FOUND");
    expect(mocks.head).toHaveBeenCalledWith(KEY);
    expect(mocks.setSetting).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("records what R2 says it holds, not what the client claimed", async () => {
    const response = await confirm();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.message).toBe("Background video updated");
    expect(body.data.backgroundVideo).toEqual({
      active: true,
      token: TOKEN,
      mimeType: "video/mp4",
      name: "hero.mp4",
      size: 4_096,
    });

    const [key, value, actor] = mocks.setSetting.mock.calls[0];
    expect(key).toBe("site.background_video");
    expect(JSON.parse(value as string).size).toBe(4_096);
    expect(JSON.parse(value as string).size).not.toBe(UPLOAD.size);
    expect(actor).toBe("admin-1");

    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });

  it("removes the clip it replaced, and only after the new one is written", async () => {
    const previous = {
      active: true,
      token: "ffffffffffffffffffffffff",
      mimeType: "video/mp4",
      name: "old.mp4",
      size: 2_048,
    };
    mocks.getBackgroundVideo.mockResolvedValue(previous);

    const response = await confirm();

    expect(response.status).toBe(200);
    expect(mocks.keyFor).toHaveBeenCalledWith(previous.token, previous.mimeType);
    expect(mocks.removeObject).toHaveBeenCalledWith(
      "site/background/ffffffffffffffffffffffff.mp4"
    );
    // Deleting first would leave the site with no backdrop at all if the write
    // above had failed.
    expect(mocks.setSetting.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeObject.mock.invocationCallOrder[0]
    );
  });

  it("does not delete anything when it confirms the SAME clip again", async () => {
    mocks.getBackgroundVideo.mockResolvedValue({
      active: true,
      token: TOKEN,
      mimeType: "video/mp4",
      name: "hero.mp4",
      size: 4_096,
    });

    await confirm();

    expect(mocks.setSetting).toHaveBeenCalledTimes(1);
    expect(mocks.removeObject).not.toHaveBeenCalled();
  });

  it("keeps the previous clip when the new row cannot be written", async () => {
    mocks.getBackgroundVideo.mockResolvedValue({
      active: true,
      token: "ffffffffffffffffffffffff",
      mimeType: "video/mp4",
      name: "old.mp4",
      size: 2_048,
    });
    mocks.setSetting.mockRejectedValue(new Error("database is down"));

    const response = await confirm();

    expect(response.status).toBe(500);
    expect(mocks.removeObject).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
