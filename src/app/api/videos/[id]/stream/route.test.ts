// =============================================================================
// GENHUB - Tests for GET /api/videos/[id]/stream
//
// This route is the only thing standing between a viewer and the video CDN, so
// three properties are pinned here:
//
//   1. WHAT IT RETURNS is a manifest a player can actually use — every segment
//      URL carries its own authorisation, because a query string in the
//      manifest's own URL does not survive an HLS player's relative-URL
//      resolution. That was the spinner-forever bug.
//   2. WHO IT RETURNS IT TO is decided here, not by whoever had the link. The
//      route re-derives entitlement exactly as GET /api/videos/[id] did before
//      it handed out a playback URL, and `?source=teaser` is not a way around
//      that: it only serves when the row really has a separate trailer.
//   3. WHAT IT WILL FETCH is a playlist and nothing else. Segments are served by
//      the CDN directly; if this route would fetch them, it would be an open
//      proxy paying for the entire library's bandwidth out of our account.
//
// Prisma, auth and the CDN are mocked — no database and no network.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";

const GUID = "39ea50b0-bee6-4175-90fe-99710ecc3848";
const TEASER_GUID = "9c1f2a3b-4d5e-4f60-8a91-b2c3d4e5f607";
const CDN = "vz-test.b-cdn.net";
const SECRET = "pull-zone-key";

const mocks = vi.hoisted(() => ({
  videoFindFirst: vi.fn(),
  accessFindFirst: vi.fn(),
  accessUpsert: vi.fn(),
  transactionFindFirst: vi.fn(),
  subscriptionFindFirst: vi.fn(),
  currentUser: vi.fn(),
}));

const bunnyConfig = vi.hoisted(() => ({
  libraryId: "760553",
  apiKey: "stream-key",
  storageZone: "",
  storageAccessKey: "",
  cdnHostname: "vz-test.b-cdn.net",
  tokenSecret: "pull-zone-key",
}));

vi.mock("@/lib/db", () => ({
  default: {
    video: { findFirst: mocks.videoFindFirst },
    videoAccess: { findFirst: mocks.accessFindFirst, upsert: mocks.accessUpsert },
    transaction: { findFirst: mocks.transactionFindFirst },
    creatorSubscription: { findFirst: mocks.subscriptionFindFirst },
  },
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getCurrentUser: () => mocks.currentUser() };
});

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  return { ...actual, default: { ...actual.default, bunny: bunnyConfig } };
});

import { NextRequest } from "next/server";
import { GET } from "./route";

const MASTER = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "",
  '#EXT-X-STREAM-INF:BANDWIDTH=1014185,RESOLUTION=358x640,CLOSED-CAPTIONS=NONE',
  "360p/video.m3u8",
].join("\n");

const RENDITION = [
  "#EXTM3U",
  "#EXT-X-TARGETDURATION:4",
  "#EXTINF:4.000,",
  "video0.ts",
  "#EXT-X-ENDLIST",
].join("\n");

const ROW = {
  id: "row-1",
  price: 0,
  creatorId: "creator-1",
  bunnyVideoId: GUID,
  teaserBunnyVideoId: null as string | null,
};

/**
 * Answer the two access lookups this route makes through the shared entitlement
 * service — one for a live row (lifetime, or not yet expired), one for a row that
 * has run out. Which is which is entirely in the `expiresAt` clause, so the mock
 * reads the query rather than depending on call order.
 *
 * An expired row being answered here (rather than as `live: null`) is the case
 * that matters: the route must refuse a viewer whose rental ran out, and must not
 * let the self-heal quietly re-issue it as a permanent purchase.
 */
function setAccessRows({ live = null, expired = null }: { live?: unknown; expired?: unknown } = {}) {
  mocks.accessFindFirst.mockImplementation(
    async (args: { where?: { expiresAt?: { lte?: Date } } }) =>
      args?.where?.expiresAt?.lte ? expired : live
  );
}

/** The signature the pull zone accepts: base64url(sha256(secret + path + expires)). */
const expectedToken = (path: string, expires: number) =>
  createHash("sha256")
    .update(`${SECRET}${path}${expires}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const bodyOf = (upstreamBody: string, status = 200) =>
  new Response(upstreamBody, { status, headers: { "Content-Type": "application/vnd.apple.mpegurl" } });

function request(query = "", id = "row-1") {
  return new NextRequest(`http://localhost:3000/api/videos/${id}/stream${query}`);
}

const params = (id = "row-1") => ({ params: { id } });

let urls: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  urls = [];
  bunnyConfig.cdnHostname = CDN;
  bunnyConfig.tokenSecret = SECRET;
  mocks.videoFindFirst.mockResolvedValue(ROW);
  setAccessRows();
  mocks.accessUpsert.mockResolvedValue({ id: "access-1" });
  mocks.transactionFindFirst.mockResolvedValue(null);
  mocks.subscriptionFindFirst.mockResolvedValue(null);
  mocks.currentUser.mockResolvedValue(null);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      return bodyOf(url.includes("/360p/") ? RENDITION : MASTER);
    })
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("GET /api/videos/[id]/stream - what it returns", () => {
  it("hands back a manifest whose nested playlists come back through this route", async () => {
    const res = await GET(request(), params());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/vnd.apple.mpegurl");
    // Tokens are baked into the body, so no shared cache may hold it.
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");

    const body = await res.text();
    expect(body).toContain("/api/videos/row-1/stream?path=360p%2Fvideo.m3u8");
    expect(body).toContain("#EXT-X-VERSION:3");
  });

  it("authorises every segment with a folder signature, since the manifest's own query cannot reach them", async () => {
    const res = await GET(request("?path=360p%2Fvideo.m3u8"), params());
    const body = await res.text();

    // The upstream call carries a token signed for the video's FOLDER...
    const upstream = new URL(urls[0]);
    const expires = Number(upstream.searchParams.get("expires"));
    expect(urls[0].startsWith(`https://${CDN}/${GUID}/360p/video.m3u8?`)).toBe(true);
    expect(upstream.searchParams.get("token")).toBe(expectedToken(`/${GUID}/`, expires));

    // ...and so does the segment URL written into the manifest we return.
    expect(body).toContain(`https://${CDN}/${GUID}/360p/video0.ts?token=`);
    expect(body).not.toContain("\nvideo0.ts");
  });

  it("serves the teaser's own folder when asked for the teaser", async () => {
    mocks.videoFindFirst.mockResolvedValue({ ...ROW, price: 5000, teaserBunnyVideoId: TEASER_GUID });

    const res = await GET(request("?source=teaser"), params());

    expect(res.status).toBe(200);
    expect(urls[0]).toContain(`/${TEASER_GUID}/playlist.m3u8`);
    // A trailer is for people who have not paid, so no session is required...
    expect(mocks.accessFindFirst).not.toHaveBeenCalled();
    // ...but the nested playlists must stay teasers, not become the scene.
    expect(await res.text()).toContain("/api/videos/row-1/stream?path=360p%2Fvideo.m3u8&source=teaser");
  });
});

describe("GET /api/videos/[id]/stream - who gets it", () => {
  it("lets anyone watch a free video", async () => {
    expect((await GET(request(), params())).status).toBe(200);
  });

  it("refuses a paid video to a viewer with no purchase, without touching the CDN", async () => {
    mocks.videoFindFirst.mockResolvedValue({ ...ROW, price: 5000 });

    const res = await GET(request(), params());

    expect(res.status).toBe(403);
    expect(urls).toEqual([]);
  });

  it("refuses a viewer whose rental ran out, even though the charge is on record", async () => {
    // The paywall that expires. `VideoAccess.expiresAt` is nullable and null
    // means lifetime, so a past expiry has to end access — and the failed-lookup
    // self-heal must not treat the dead row as a missing one and hand back a
    // permanent copy of a scene that was rented for a day.
    mocks.videoFindFirst.mockResolvedValue({ ...ROW, price: 5000 });
    mocks.currentUser.mockResolvedValue({ userId: "viewer-1", role: "VIEWER" });
    setAccessRows({ expired: { id: "access-expired" } });
    mocks.transactionFindFirst.mockResolvedValue({ id: "txn-1" });

    const res = await GET(request(), params());

    expect(res.status).toBe(403);
    expect(urls).toEqual([]);
    expect(mocks.accessUpsert).not.toHaveBeenCalled();
  });

  it("refuses an anonymous visitor, so a copied link is not a purchase", async () => {
    mocks.videoFindFirst.mockResolvedValue({ ...ROW, price: 5000 });
    mocks.currentUser.mockResolvedValue(null);

    expect((await GET(request(), params())).status).toBe(403);
    expect(urls).toEqual([]);
  });

  it("serves a paid video to a viewer who owns it", async () => {
    mocks.videoFindFirst.mockResolvedValue({ ...ROW, price: 5000 });
    mocks.currentUser.mockResolvedValue({ userId: "viewer-1", role: "VIEWER" });
    setAccessRows({ live: { id: "access-1" } });

    expect((await GET(request(), params())).status).toBe(200);
  });

  it("heals a paid viewer whose purchase exists without an access row", async () => {
    mocks.videoFindFirst.mockResolvedValue({ ...ROW, price: 5000 });
    mocks.currentUser.mockResolvedValue({ userId: "viewer-1", role: "VIEWER" });
    mocks.transactionFindFirst.mockResolvedValue({ id: "txn-1" });

    expect((await GET(request(), params())).status).toBe(200);
  });

  // The hole `?source=teaser` could otherwise open: a paid scene with no trailer
  // requested through the teaser door, which skips entitlement.
  it("does not serve a paid scene through ?source=teaser when it has no trailer", async () => {
    mocks.videoFindFirst.mockResolvedValue({ ...ROW, price: 5000, teaserBunnyVideoId: null });

    const res = await GET(request("?source=teaser"), params());

    expect(res.status).toBe(403);
    expect(urls).toEqual([]);
  });

  it("lets the creator watch their own upload", async () => {
    mocks.videoFindFirst.mockResolvedValue({ ...ROW, price: 5000 });
    mocks.currentUser.mockResolvedValue({ userId: "creator-1", role: "CREATOR" });

    expect((await GET(request(), params())).status).toBe(200);
  });

  // A monthly subscription is worth as much here as it is on the page that sold
  // it — the stream route and the paywall must not disagree about that.
  it("lets an active subscriber watch a paid scene", async () => {
    mocks.videoFindFirst.mockResolvedValue({ ...ROW, price: 5000 });
    mocks.currentUser.mockResolvedValue({ userId: "viewer-1", role: "VIEWER" });
    mocks.subscriptionFindFirst.mockResolvedValue({ id: "sub-1" });

    expect((await GET(request(), params())).status).toBe(200);
  });

  it("still refuses a signed-out visitor with an expired subscription", async () => {
    mocks.videoFindFirst.mockResolvedValue({ ...ROW, price: 5000 });
    mocks.subscriptionFindFirst.mockResolvedValue(null);

    const res = await GET(request(), params());

    expect(res.status).toBe(403);
    expect(urls).toEqual([]);
  });

  it("404s an unknown or deleted video", async () => {
    mocks.videoFindFirst.mockResolvedValue(null);
    expect((await GET(request(), params())).status).toBe(404);
  });

  // Demo/side-loaded rows hold "" in the non-nullable bunnyVideoId column.
  it("404s a row that has no Bunny GUID", async () => {
    mocks.videoFindFirst.mockResolvedValue({ ...ROW, price: 0, bunnyVideoId: "" });

    const res = await GET(request(), params());

    expect(res.status).toBe(404);
    expect(urls).toEqual([]);
  });
});

describe("GET /api/videos/[id]/stream - what it will fetch", () => {
  it.each([
    ["an absolute URL", "path=https%3A%2F%2Fevil.test%2Fx.m3u8"],
    ["a traversal", "path=..%2F..%2Fsecret.m3u8"],
    ["a segment", "path=play_720p.mp4"],
    ["a nested traversal", "path=360p%2F..%2F..%2Fother%2Fplaylist.m3u8"],
  ])("refuses %s", async (_label, query) => {
    const res = await GET(request(`?${query}`), params());

    expect(res.status).toBe(400);
    expect(urls).toEqual([]);
  });
});

describe("GET /api/videos/[id]/stream - when the CDN says no", () => {
  it("names the variable at fault when Bunny refuses the signature", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Forbidden", { status: 403 })));

    const res = await GET(request(), params());

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/BUNNY_TOKEN_SECRET/);
    // The reader has to be able to tell "wrong key" from "unreachable host",
    // so the answer names the host it asked and the status it got back.
    expect(body.error).toContain(CDN);
    expect(body.error).toContain("403");
  });

  it("reports a video with no rendition yet as 404, not as a broken site", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    expect((await GET(request(), params())).status).toBe(404);
  });

  it("refuses with a named reason when nothing can be signed", async () => {
    bunnyConfig.tokenSecret = "";

    const res = await GET(request(), params());

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("NOT_CONFIGURED");
    expect(urls).toEqual([]);
  });
});
