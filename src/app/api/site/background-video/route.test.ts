// =============================================================================
// GENHUB - Tests for GET/HEAD /api/site/background-video
//
// This route is the backdrop: it answers every page load, and it answers them
// with a range request the moment a browser wants to seek. What would break it,
// pinned here:
//
//   * no clip set -> 404 with no-store, so the layer unmounts instead of
//     spinning on an address that will never return bytes;
//   * `?v=` matching the stored token -> cacheable for a year, because a
//     backdrop is the same bytes on every page;
//   * `?v=` NOT matching -> the current clip, but never remembered, so a
//     replaced backdrop cannot outlive its replacement;
//   * Range -> 206 with Content-Range, and 416 past the end. A server that
//     answers a range with the whole clip and a 200 is a server browsers treat
//     as unable to stream;
//   * a response never larger than the platform's payload limit, which is what
//     the slice cap below is for;
//   * a slice that does not come back whole -> 500, never a 200 that promises
//     bytes it does not have.
//
// The settings service and the storage service are mocked. Nothing here touches
// a database or a disk.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { MAX_BACKGROUND_VIDEO_SLICE_BYTES } from "@/lib/background-video";

const mocks = vi.hoisted(() => ({
  getBackgroundVideo: vi.fn(),
  readAsset: vi.fn(),
  readSlice: vi.fn(),
}));

vi.mock("@/lib/services/platform-setting.service", () => ({
  getBackgroundVideo: mocks.getBackgroundVideo,
}));

vi.mock("@/lib/services/background-video.service", () => ({
  readBackgroundVideoAsset: mocks.readAsset,
  readBackgroundVideoSlice: mocks.readSlice,
}));

import { GET, HEAD } from "./route";

const TOKEN = "0123456789abcdef01234567";
const SIZE = 256;

/** Bytes that are recognisably not all the same, so a slice can be checked. */
function payload(): Buffer {
  const buf = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i++) buf[i] = i % 251;
  return buf;
}

function active() {
  return {
    active: true,
    token: TOKEN,
    mimeType: "video/mp4",
    name: "hero.mp4",
    size: SIZE,
  };
}

function url(query = `?v=${TOKEN}`) {
  return `http://localhost/api/site/background-video${query}`;
}

function get(query = `?v=${TOKEN}`, headers: Record<string, string> = {}) {
  return GET(new NextRequest(url(query), { headers }));
}

async function bytes(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBackgroundVideo.mockResolvedValue(active());
  mocks.readAsset.mockResolvedValue({ mimeType: "video/mp4", name: "hero.mp4", size: SIZE });
  mocks.readSlice.mockImplementation(async (_id: string, start: number, end: number) =>
    payload().subarray(start, end + 1)
  );
});

describe("GET /api/site/background-video", () => {
  it("404s with no-store when no clip is set, so the layer can unmount", async () => {
    mocks.getBackgroundVideo.mockResolvedValue({
      active: false,
      token: "",
      mimeType: "",
      name: "",
      size: 0,
    });

    const response = await get(`?v=${TOKEN}`);

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect((await response.json()).code).toBe("NOT_FOUND");
  });

  it("serves the whole clip when the version matches, cacheable for a year", async () => {
    const response = await get();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Length")).toBe(String(SIZE));
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    // A fixed word plus the stored extension — never the operator's filename,
    // which would otherwise be reflected to every visitor in a header some
    // clients render.
    expect(response.headers.get("Content-Disposition")).toBe(
      'inline; filename="background.mp4"'
    );

    expect(await bytes(response)).toEqual(payload());
  });

  it("asks storage for the slice it is going to answer with, not the whole clip", async () => {
    await get(`?v=${TOKEN}`, { Range: "bytes=10-19" });

    expect(mocks.readSlice).toHaveBeenCalledWith(TOKEN, 10, 19);
  });

  it("answers a range with 206 and exactly the bytes asked for", async () => {
    const response = await get(`?v=${TOKEN}`, { Range: "bytes=0-99" });

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes 0-99/${SIZE}`);
    expect(response.headers.get("Content-Length")).toBe("100");

    const body = await bytes(response);
    expect(body.length).toBe(100);
    expect(body).toEqual(payload().subarray(0, 100));
  });

  it("answers the whole-clip range a <video> opens with a 206, never a 200", async () => {
    // `bytes=0-` is the very first request every <video> makes. Answering it
    // with a 200 tells the browser this server cannot serve bytes at all: it
    // stops seeking, waits out the whole download, and on a clip of any real
    // size that download never completes — so the backdrop never plays.
    const response = await get(`?v=${TOKEN}`, { Range: "bytes=0-" });

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes 0-${SIZE - 1}/${SIZE}`);
    expect(response.headers.get("Content-Length")).toBe(String(SIZE));
    expect(await bytes(response)).toEqual(payload());
  });

  // The platform refuses a function's response body past 4.5 MB, and `bytes=0-`
  // on a clip at the ceiling is exactly how a working backdrop turns into a 413
  // that nobody can reproduce locally. Fewer bytes than were asked for is still
  // a range, and Content-Range is where the browser learns to continue from.
  it("answers with a shorter range than was asked for, and says where to continue", async () => {
    const big = MAX_BACKGROUND_VIDEO_SLICE_BYTES * 3;
    mocks.readAsset.mockResolvedValue({ mimeType: "video/mp4", name: "hero.mp4", size: big });
    mocks.readSlice.mockImplementation(async (_id: string, start: number, end: number) =>
      Buffer.alloc(end - start + 1)
    );

    const response = await get(`?v=${TOKEN}`, { Range: "bytes=0-" });

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(
      `bytes 0-${MAX_BACKGROUND_VIDEO_SLICE_BYTES - 1}/${big}`
    );
    expect(response.headers.get("Content-Length")).toBe(
      String(MAX_BACKGROUND_VIDEO_SLICE_BYTES)
    );
    expect(mocks.readSlice).toHaveBeenCalledWith(TOKEN, 0, MAX_BACKGROUND_VIDEO_SLICE_BYTES - 1);
  });

  // No Range means no truncation: a 206 is only legal in answer to a range, and
  // the whole clip is safe here anyway because the ceiling is below the
  // platform's payload limit. The cap exists for the request that HAS a range.
  it("answers a request with no Range whole, however big the clip is", async () => {
    const big = MAX_BACKGROUND_VIDEO_SLICE_BYTES * 3;
    mocks.readAsset.mockResolvedValue({ mimeType: "video/mp4", name: "hero.mp4", size: big });
    mocks.readSlice.mockImplementation(async (_id: string, start: number, end: number) =>
      Buffer.alloc(end - start + 1)
    );

    const response = await get();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(big));
    expect(mocks.readSlice).toHaveBeenCalledWith(TOKEN, 0, big - 1);
  });

  it("answers an open-ended range from the offset to the end", async () => {
    const response = await get(`?v=${TOKEN}`, { Range: `bytes=${SIZE - 16}-` });

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(
      `bytes ${SIZE - 16}-${SIZE - 1}/${SIZE}`
    );
    expect(await bytes(response)).toEqual(payload().subarray(SIZE - 16));
  });

  it("answers a suffix range with the last N bytes", async () => {
    const response = await get(`?v=${TOKEN}`, { Range: "bytes=-10" });

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(
      `bytes ${SIZE - 10}-${SIZE - 1}/${SIZE}`
    );
    expect(await bytes(response)).toEqual(payload().subarray(SIZE - 10));
  });

  it("416s a range past the end of the clip, and says how big it is", async () => {
    const response = await get(`?v=${TOKEN}`, { Range: "bytes=999999999-" });

    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe(`bytes */${SIZE}`);
    expect((await response.text()).length).toBe(0);
  });

  // Someone is holding an address from before the clip was replaced. Serve the
  // CURRENT clip so they are not shown a backdrop that no longer exists, but
  // never let that answer be remembered.
  it("serves the current clip, uncacheable, for a version that is not the current one", async () => {
    const response = await get("?v=ffffffffffffffffffffffff");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(await bytes(response)).toEqual(payload());
  });

  it("serves it uncacheable when no version was sent at all", async () => {
    const response = await get("");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
  });

  it("404s when the row survived but the clip did not", async () => {
    mocks.readAsset.mockResolvedValue(null);

    const response = await get(`?v=${TOKEN}`);

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(mocks.readSlice).not.toHaveBeenCalled();
  });

  // A row we would not have written must not become a query at all: the token is
  // the key, and the MIME type decides the extension in a response header.
  it("404s a stored row this app would not have written", async () => {
    mocks.getBackgroundVideo.mockResolvedValue({ ...active(), token: "../../etc" });

    const response = await get("?v=../../etc");

    expect(response.status).toBe(404);
    expect(mocks.readAsset).not.toHaveBeenCalled();
  });

  // The clip is there, so this is a fault, not an absence. A 200 promising bytes
  // it does not have is what a player stalls on silently.
  it("500s rather than answering a short slice", async () => {
    mocks.readSlice.mockResolvedValue(Buffer.alloc(8));

    const response = await get(`?v=${TOKEN}`, { Range: "bytes=0-99" });

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
  });

  it("500s rather than answering an empty slice", async () => {
    mocks.readSlice.mockResolvedValue(new Uint8Array(0));

    const response = await get(`?v=${TOKEN}`, { Range: "bytes=0-99" });

    expect(response.status).toBe(500);
  });
});

describe("HEAD /api/site/background-video", () => {
  it("answers with the headers a video element needs and no body", async () => {
    const response = await HEAD(new NextRequest(url()));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(SIZE));
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect((await bytes(response)).length).toBe(0);
    // A HEAD is a question about the clip, not a request for it.
    expect(mocks.readSlice).not.toHaveBeenCalled();
  });

  it("404s the same way GET does when there is nothing to play", async () => {
    mocks.getBackgroundVideo.mockResolvedValue({
      active: false,
      token: "",
      mimeType: "",
      name: "",
      size: 0,
    });

    const response = await HEAD(new NextRequest(url()));

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
  });
});
