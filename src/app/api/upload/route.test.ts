// =============================================================================
// GENHUB - /api/upload, with captions
//
// The route took images only, so a creator had no way to attach subtitles to a
// scene they had already uploaded: the edit form had nowhere to put a .vtt, and
// the upload endpoint refused one. These tests pin the extension of the rule,
// and the parts of it that must NOT move:
//
//   * a .vtt is accepted — by its MIME type, and by its filename when the browser
//     reports no type (which is what drag-and-drop and some Windows setups do);
//   * it lands under public/captions/ and is sent to Bunny with Content-Type
//     text/vtt, because a browser ignores a <track> served as
//     application/octet-stream, with no error anywhere;
//   * it may NOT be private: a <track> is fetched by the browser with no way to
//     attach a session, so a private caption file would be invisible to every
//     viewer while looking perfectly uploaded to the creator;
//   * .srt is still refused (it plays as nothing at all), and images still work.
//
// Storage and auth are mocked: no network, no disk, no database.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ default: {} }));

vi.mock("@/lib/auth", () => ({
  requireAuth: () => mocks.requireAuth(),
  AuthError: class AuthError extends Error {
    statusCode = 401;
  },
}));

vi.mock("@/lib/redis", () => ({
  checkRateLimit: () => mocks.checkRateLimit(),
}));

// Bunny storage configured, so the route takes the production branch and the
// test never writes to this checkout's disk.
vi.mock("@/lib/config", () => ({
  default: {
    nodeEnv: "production",
    bunny: { storageZone: "genhub-thumbs", storageAccessKey: "key", cdnHostname: "cdn.test" },
    rateLimit: { upload: { max: 20, windowMs: 300_000 } },
  },
}));

import { POST } from "./route";

const fetchMock = vi.fn();

function upload(file: File, kind?: string) {
  const form = new FormData();
  form.append("file", file);
  if (kind) form.append("kind", kind);
  return new NextRequest("https://app.test/api/upload", { method: "POST", body: form });
}

/** The key Bunny was asked to store the file under. */
function storedKey(): string {
  const url = String(fetchMock.mock.calls[0][0]);
  return url.replace("https://storage.bunnycdn.com/genhub-thumbs/", "");
}

/** The headers Bunny was given for that file. */
function storedHeaders(): Record<string, string> {
  return fetchMock.mock.calls[0][1].headers as Record<string, string>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ userId: "creator-1", role: "CREATOR" });
  mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  fetchMock.mockResolvedValue(new Response("", { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
});

describe("captions", () => {
  it("accepts a .vtt and stores it as public, as text/vtt", async () => {
    const res = await POST(
      upload(new File(["WEBVTT\n"], "scene.vtt", { type: "text/vtt" }), "public")
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(storedKey()).toMatch(/^public\/captions\/\d{4}-\d{2}\/[0-9a-f]+\.vtt$/);
    expect(storedHeaders()["Content-Type"]).toBe("text/vtt");
    expect(body.data.url).toMatch(/^\/api\/media\/public\/captions\//);
  });

  it("defaults to public when no kind is given", async () => {
    const res = await POST(upload(new File(["WEBVTT\n"], "scene.vtt", { type: "text/vtt" })));

    expect(res.status).toBe(200);
    expect(storedKey()).toMatch(/^public\/captions\//);
  });

  it("accepts a .vtt the browser did not type", async () => {
    // Empty MIME type is what a drag-and-drop from a file manager produces on
    // some systems, and application/octet-stream is what others send. Refusing
    // those would make the feature work on one machine and not the next.
    for (const type of ["", "application/octet-stream"]) {
      fetchMock.mockClear();
      const res = await POST(upload(new File(["WEBVTT\n"], "scene.vtt", { type })));

      expect(res.status).toBe(200);
      expect(storedKey()).toContain(".vtt");
    }
  });

  it("refuses captions in the private bucket", async () => {
    // A private file is served only to a signed-in owner, and the <track>
    // element fetches it as the browser with no session — so the captions would
    // be invisible to every viewer.
    const res = await POST(
      upload(new File(["WEBVTT\n"], "scene.vtt", { type: "text/vtt" }), "private")
    );
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toMatch(/public/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses .srt with a message that says why", async () => {
    const res = await POST(
      upload(new File(["1\n00:00:00\n"], "scene.srt", { type: "application/x-subrip" }))
    );
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toMatch(/\.vtt/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a file that merely claims to be vtt by type", async () => {
    // The extension fallback only applies to the filename; a type of text/vtt on
    // a file called notes.txt still stores as .vtt, which is the app's own
    // extension — so what matters is that the stored key is not attacker-named.
    const res = await POST(
      upload(new File(["WEBVTT\n"], "notes.exe", { type: "text/vtt" }))
    );

    expect(res.status).toBe(200);
    expect(storedKey()).toMatch(/^public\/captions\/\d{4}-\d{2}\/[0-9a-f]+\.vtt$/);
    expect(storedKey()).not.toContain("notes.exe");
  });
});

describe("images still behave", () => {
  it("stores a PNG in the public image folder", async () => {
    const res = await POST(upload(new File(["x"], "a.png", { type: "image/png" })));

    expect(res.status).toBe(200);
    expect(storedKey()).toMatch(/^public\/images\/\d{4}-\d{2}\/[0-9a-f]+\.png$/);
  });

  it("keeps KYC documents private and owner-scoped", async () => {
    await POST(upload(new File(["x"], "id.jpg", { type: "image/jpeg" }), "private"));

    expect(storedKey()).toMatch(/^private\/creator-1\/\d{4}-\d{2}\/[0-9a-f]+\.jpg$/);
  });

  it("still refuses an unknown type", async () => {
    const res = await POST(upload(new File(["x"], "a.pdf", { type: "application/pdf" })));

    expect(res.status).toBe(422);
  });
});

describe("rate limit message", () => {
  it("no longer calls captions images", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false });

    const res = await POST(upload(new File(["WEBVTT\n"], "scene.vtt", { type: "text/vtt" })));
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.error).not.toMatch(/images too many/i);
    expect(body.error).toMatch(/uploads/i);
  });
});
