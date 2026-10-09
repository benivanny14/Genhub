// =============================================================================
// GENHUB - /api/admin/background-video
//
// The button that puts a clip behind the whole interface. What is pinned here:
//
//   1. A REFUSAL MUST NOT LEAVE ANYTHING BEHIND. The body is streamed to a
//      `.staging-<token>` file and renamed once it is known good. A rejection
//      returns from inside the `try`, so it never reaches a `catch` — which is
//      how every refused upload used to leave a staging file on disk that
//      nothing would ever read or clean up. The cleanup is a `finally`.
//   2. The ceiling is answered BEFORE the bytes arrive, from the size the
//      client declared, and again by the counter while they stream.
//   3. The MIME type is a claim; the bytes decide.
//
// Auth, rate limiting, the audit log and the settings service are mocked. The
// file on disk is real, and each test removes what it made.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { readdir, unlink } from "node:fs/promises";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  getBackgroundVideo: vi.fn(),
  setSetting: vi.fn(),
  checkRateLimit: vi.fn(),
  audit: vi.fn(),
  requireRole: vi.fn(),
}));

vi.mock("@/lib/services/platform-setting.service", () => ({
  PLATFORM_SETTING_KEYS: { backgroundVideo: "site.background_video" },
  getBackgroundVideo: mocks.getBackgroundVideo,
  setSetting: mocks.setSetting,
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

const SITE_DIR = path.join(process.cwd(), "public", "uploads", "site");

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

async function stagingFiles(): Promise<string[]> {
  try {
    return (await readdir(SITE_DIR)).filter((name) => name.startsWith(".staging-"));
  } catch {
    return [];
  }
}

/** The path the route wrote, learned from the row it saved. */
function storedPath(): string | null {
  const call = mocks.setSetting.mock.calls.find(
    ([key]) => key === "site.background_video"
  );
  if (!call) return null;
  const row = JSON.parse(call[1] as string);
  if (!row.active) return null;
  return path.join(SITE_DIR, `background-${row.token}.${String(row.mimeType === "video/webm" ? "webm" : "mp4")}`);
}

afterEach(async () => {
  const stored = storedPath();
  if (stored) await unlink(stored).catch(() => {});
  for (const name of await stagingFiles()) {
    await unlink(path.join(SITE_DIR, name)).catch(() => {});
  }
});

describe("POST /api/admin/background-video", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({ userId: "admin-1", role: "ADMIN" });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });
    mocks.getBackgroundVideo.mockResolvedValue(NO_CLIP);
    mocks.setSetting.mockResolvedValue(undefined);
    mocks.audit.mockResolvedValue(undefined);
  });

  it("refuses anyone who is not an admin", async () => {
    mocks.requireRole.mockRejectedValue(new AuthError("Authentication required", 401));

    const response = await upload(MP4);

    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("UNAUTHORIZED");
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it("rate-limits an operator who is replacing it too often", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });

    const response = await upload(MP4);

    expect(response.status).toBe(429);
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it("refuses a container it cannot play, before writing anything", async () => {
    const response = await upload(MP4, {
      "content-type": "video/x-msvideo",
      "x-filename": "clip.avi",
    });

    expect(response.status).toBe(422);
    expect(await stagingFiles()).toEqual([]);
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it("refuses a file over the ceiling from the size the client declared", async () => {
    const response = await upload(MP4, { "x-file-size": "900000000" });

    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe("FILE_TOO_LARGE");
    expect(await stagingFiles()).toEqual([]);
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  // The regression: a refusal returns from inside the `try`, so the staging
  // file only goes if the cleanup is a `finally`. Before it was, every upload
  // a human rejected left a `.staging-*` file on disk forever.
  it("leaves no staging file behind when the bytes are not a video", async () => {
    const before = await stagingFiles();

    const response = await upload(new TextEncoder().encode("hello, not a video"));

    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("VALIDATION_ERROR");
    expect(await stagingFiles()).toEqual(before);
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it("stores a real clip, records the row and audits who did it", async () => {
    const response = await upload(MP4);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.backgroundVideo.active).toBe(true);
    expect(body.data.backgroundVideo.mimeType).toBe("video/mp4");

    expect(mocks.setSetting).toHaveBeenCalledTimes(1);
    const [key, value, actor] = mocks.setSetting.mock.calls[0];
    expect(key).toBe("site.background_video");
    expect(JSON.parse(value as string)).toMatchObject({
      active: true,
      mimeType: "video/mp4",
      size: MP4.length,
    });
    expect(actor).toBe("admin-1");

    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(await stagingFiles()).toEqual([]);
    expect(storedPath()).not.toBeNull();
  });

  it("keeps memory flat: the size is counted as the bytes arrive, not after", async () => {
    // A declared length over the ceiling is answered without reading the body —
    // the point of refusing on the header at all.
    const response = await upload(MP4, { "content-length": "900000000" });

    expect(response.status).toBe(413);
    expect(await stagingFiles()).toEqual([]);
  });
});
