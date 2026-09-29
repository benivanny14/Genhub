// =============================================================================
// GENHUB - Tests for the signed Bunny upload session
//
// The session token is the only thing standing between one creator's upload and
// another creator's video row, and it is handed to a browser — so it has to be
// safe to hand over. Four properties are pinned here:
//
//   1. A token verifies only for the creator it was signed for. The token names
//      a Bunny video id, and POST /api/videos trusts that pairing; a stolen
//      token must not let somebody attach someone else's asset to their post.
//   2. A token cannot be pointed at another host. `uploadUrl` is where the
//      browser sends the bytes, so an attacker-supplied value would turn the
//      creator's own upload into a transfer to a third party.
//   3. A modified token is refused, because the signature is what makes 1 and 2
//      true and a browser holds all the bytes of the payload.
//   4. `confirmVideoUpload` refuses to call an upload finished while Bunny's own
//      offset is short. This is the check that makes "complete" mean complete.
//
// `@/lib/config` and `@/lib/bunny` are mocked so the suite runs anywhere: no
// JWT_SECRET from a developer's .env.local, no Stream library, no network.
// =============================================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";

const JWT_SECRET = "genhub-test-upload-secret";
const LIBRARY_ID = "lib-1";
const API_KEY = "lib-api-key";

vi.mock("@/lib/config", () => ({
  default: {
    jwtSecret: JWT_SECRET,
    bunny: { apiKey: API_KEY, libraryId: LIBRARY_ID },
  },
}));

vi.mock("@/lib/bunny", () => ({
  createVideoUpload: vi.fn(),
  deleteBunnyVideo: vi.fn(async () => undefined),
}));

const { confirmVideoUpload, isUploadSessionConfigured, verifyVideoUploadSession } = await import(
  "@/lib/video-upload-session"
);

afterEach(() => {
  vi.unstubAllGlobals();
});

async function sign(
  payload: Record<string, unknown>,
  options: { expiresIn?: number | string; secret?: string } = {}
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("genhub")
    .setAudience("video-upload")
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "1h")
    .sign(new TextEncoder().encode(options.secret ?? JWT_SECRET));
}

function payloadFor(userId: string) {
  return {
    userId,
    videoId: "video-1",
    uploadUrl: "https://video.bunnycdn.com/tusupload/session-1",
    headers: { LibraryId: LIBRARY_ID, VideoId: "video-1" },
    totalBytes: 100,
    expiresAt: Math.floor(Date.now() / 1000) + 3_600,
  };
}

describe("verifyVideoUploadSession", () => {
  it("accepts a token for the creator it was signed for", async () => {
    const token = await sign(payloadFor("creator-1"));

    await expect(verifyVideoUploadSession(token, "creator-1")).resolves.toMatchObject({
      userId: "creator-1",
      videoId: "video-1",
      totalBytes: 100,
    });
  });

  it("refuses the same token for a different creator", async () => {
    // The whole point of the signature: a token in one browser must be worthless
    // in another, or a leaked one attaches somebody's upload to a stranger's post.
    const token = await sign(payloadFor("creator-1"));

    await expect(verifyVideoUploadSession(token, "creator-2")).resolves.toBeNull();
  });

  it("refuses a token whose signature was altered", async () => {
    // A browser holds every byte of the payload, so the signature is the only
    // thing making the claims true.
    const token = await sign(payloadFor("creator-1"), { secret: "not-the-server-secret" });

    await expect(verifyVideoUploadSession(token, "creator-1")).resolves.toBeNull();
  });

  it("refuses an expired token", async () => {
    const token = await sign(payloadFor("creator-1"), { expiresIn: Math.floor(Date.now() / 1000) - 60 });

    await expect(verifyVideoUploadSession(token, "creator-1")).resolves.toBeNull();
  });

  it("refuses a session pointed at a host that is not Bunny", async () => {
    // `uploadUrl` is where the browser sends the file. A value the browser could
    // influence would redirect a creator's video to a third party.
    const token = await sign({
      ...payloadFor("creator-1"),
      uploadUrl: "https://evil.example.com/tusupload/session-1",
    });

    await expect(verifyVideoUploadSession(token, "creator-1")).resolves.toBeNull();
  });

  it("refuses an unsigned string", async () => {
    await expect(verifyVideoUploadSession("not-a-token", "creator-1")).resolves.toBeNull();
  });
});

describe("confirmVideoUpload", () => {
  function session(totalBytes: number) {
    return {
      sessionToken: "token",
      userId: "creator-1",
      videoId: "video-1",
      uploadUrl: "https://video.bunnycdn.com/tusupload/session-1",
      headers: { LibraryId: LIBRARY_ID },
      totalBytes,
      expiresAt: Math.floor(Date.now() / 1000) + 3_600,
    };
  }

  it("confirms only when Bunny holds every declared byte", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204, headers: { "upload-offset": "100" } }))
    );

    await expect(confirmVideoUpload(session(100))).resolves.toEqual({ ok: true, offset: 100 });
  });

  it("refuses a short upload and says how short", async () => {
    // 409, not a success: the row is only written after this check, which is what
    // keeps a half-arrived file from becoming a published, unplayable post.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204, headers: { "upload-offset": "40" } }))
    );

    const result = await confirmVideoUpload(session(100));

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.ok === false && result.detail).toMatch(/40 of 100/);
  });

  it("refuses an upload Bunny cannot answer for", async () => {
    // An unreachable host answers zero, and zero bytes is never complete.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );

    await expect(confirmVideoUpload(session(100))).resolves.toMatchObject({ ok: false, status: 409 });
  });
});

// Last in the file on purpose: `resetModules` gives the NEXT import a fresh
// copy of config, so these two runs cannot disturb the suite above them.
describe("isUploadSessionConfigured", () => {
  it("is true for a real secret", () => {
    expect(isUploadSessionConfigured()).toBe(true);
  });

  it("is false while JWT_SECRET is the development default", async () => {
    // The route gates on this, so the operator is told the secret is missing
    // rather than handed a 502 that blames Bunny. A deployment in this state
    // cannot sign a session at all, which is why it must be detectable BEFORE
    // a creator's file has already been chosen.
    vi.resetModules();
    vi.doMock("@/lib/config", () => ({
      default: {
        jwtSecret: "dev-secret-change-in-production",
        bunny: { apiKey: API_KEY, libraryId: LIBRARY_ID },
      },
    }));

    const fresh = await import("@/lib/video-upload-session");

    expect(fresh.isUploadSessionConfigured()).toBe(false);
  });
});
