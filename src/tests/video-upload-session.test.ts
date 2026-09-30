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
//   2. The credentials inside it are complete and belong to the video the token
//      names, and the session carries NO upload URL: Bunny serves a TUS resource
//      only to the network that opened it, so the browser opens its own (see
//      `openVideoUpload`) instead of trusting a URL that arrived from another
//      region and answers everything there with 404.
//   3. A modified token is refused, because the signature is what makes 1 and 2
//      true and a browser holds all the bytes of the payload.
//   4. `confirmVideoUpload` refuses to call an upload finished until Bunny's own
//      API reports the file — asked of the management API, never of the TUS
//      resource, which belongs to the browser's network.
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
  createVideoUpload: vi.fn(async () => ({ videoId: "video-1", libraryId: LIBRARY_ID })),
  deleteBunnyVideo: vi.fn(async () => undefined),
  getBunnyVideoDetails: vi.fn(async () => ({ status: 0, length: 0 })),
}));

const { getBunnyVideoDetails } = await import("@/lib/bunny");
const {
  confirmVideoUpload,
  createVideoUploadSession,
  isUploadSessionConfigured,
  verifyVideoUploadSession,
} = await import("@/lib/video-upload-session");

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

/** Bunny's four presigned headers, as `tusAuthHeaders` builds them. */
function signedHeaders(videoId = "video-1") {
  return {
    AuthorizationSignature: "0".repeat(64),
    AuthorizationExpire: String(Math.floor(Date.now() / 1000) + 3_600),
    LibraryId: LIBRARY_ID,
    VideoId: videoId,
  };
}

function payloadFor(userId: string) {
  return {
    userId,
    videoId: "video-1",
    headers: signedHeaders(),
    totalBytes: 100,
    mimeType: "video/mp4",
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

  it("refuses credentials that belong to a different video than the token names", async () => {
    // The id in the token is the one POST /api/videos trusts. Credentials for
    // another slot would send the bytes somewhere that row never looks.
    const token = await sign({ ...payloadFor("creator-1"), headers: signedHeaders("video-2") });

    await expect(verifyVideoUploadSession(token, "creator-1")).resolves.toBeNull();
  });

  it("refuses a session whose credentials are incomplete", async () => {
    // Bunny revalidates all four on every request and reports a missing one as
    // a 404 that reads like an upload that has gone away, so it is caught here.
    const headers: Record<string, string> = signedHeaders();
    delete headers.AuthorizationSignature;

    const token = await sign({ ...payloadFor("creator-1"), headers });

    await expect(verifyVideoUploadSession(token, "creator-1")).resolves.toBeNull();
  });

  it("refuses an unsigned string", async () => {
    await expect(verifyVideoUploadSession("not-a-token", "creator-1")).resolves.toBeNull();
  });
});

describe("createVideoUploadSession", () => {
  it("reserves the slot and signs credentials, and opens nothing", async () => {
    // The create POST has to come from the browser, so this must not hand back a
    // resource somebody opened in another region — that URL is a 404 to every
    // request the creator's own browser makes.
    const session = await createVideoUploadSession({
      userId: "creator-1",
      title: "scene",
      totalBytes: 100,
      mimeType: "video/mp4",
    });

    expect(session.videoId).toBe("video-1");
    expect("uploadUrl" in session).toBe(false);
    expect(session.headers).toMatchObject({ LibraryId: LIBRARY_ID, VideoId: "video-1" });
    expect(session.headers.AuthorizationSignature).toMatch(/^[0-9a-f]{64}$/);
    // The token it signs is the one that comes back through verification, which
    // is the pairing the publish route trusts.
    await expect(verifyVideoUploadSession(session.sessionToken, "creator-1")).resolves.toMatchObject({
      videoId: "video-1",
      totalBytes: 100,
    });
  });
});

describe("confirmVideoUpload", () => {
  function session(totalBytes: number) {
    return {
      sessionToken: "token",
      userId: "creator-1",
      videoId: "video-1",
      headers: signedHeaders(),
      totalBytes,
      mimeType: "video/mp4",
      expiresAt: Math.floor(Date.now() / 1000) + 3_600,
    };
  }

  it("confirms once Bunny reports the file, whatever network uploaded it", async () => {
    vi.mocked(getBunnyVideoDetails).mockResolvedValue({ status: 2, length: 536 });

    await expect(confirmVideoUpload(session(100))).resolves.toEqual({ ok: true, offset: 100 });
  });

  it("asks Bunny's API, never the TUS resource the browser owns", async () => {
    // A HEAD from this region is a 404 by design: the upload resource belongs to
    // the browser's network. Asking it here is what made a finished upload look
    // unfinished.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.mocked(getBunnyVideoDetails).mockResolvedValue({ status: 4, length: 536 });

    await expect(confirmVideoUpload(session(100))).resolves.toEqual({ ok: true, offset: 100 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("waits a moment for Bunny's own bookkeeping to catch up", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(getBunnyVideoDetails)
        .mockResolvedValueOnce({ status: 0, length: 0 })
        .mockResolvedValue({ status: 2, length: 536 });

      const pending = confirmVideoUpload(session(100));
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(pending).resolves.toEqual({ ok: true, offset: 100 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a slot Bunny still lists as empty, however sure the browser is", async () => {
    // 409, not a success: the row is only written after this check, which is what
    // keeps a half-arrived file from becoming a published, unplayable post.
    vi.useFakeTimers();
    try {
      vi.mocked(getBunnyVideoDetails).mockResolvedValue({ status: 0, length: 0 });

      const pending = confirmVideoUpload(session(100));
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;

      expect(result).toMatchObject({ ok: false, status: 409 });
      expect(result.ok === false && result.detail).toMatch(/empty/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an upload Bunny cannot answer for", async () => {
    vi.mocked(getBunnyVideoDetails).mockRejectedValue(new Error("Failed to get video details: video-1"));

    await expect(confirmVideoUpload(session(100))).resolves.toMatchObject({ ok: false, status: 502 });
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
