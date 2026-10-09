// =============================================================================
// GENHUB - Tests for GET/HEAD /api/site/background-video
//
// This route is the backdrop: it answers every page load, and it answers them
// with a range request the moment a browser wants to seek. The four things that
// would break it, pinned here:
//
//   * no clip set -> 404 with no-store, so the layer unmounts instead of
//     spinning on an address that will never return bytes;
//   * `?v=` matching the stored token -> cacheable for a year, because a
//     backdrop is the same bytes on every page;
//   * `?v=` NOT matching -> the current file, but never remembered, so a
//     replaced clip cannot outlive its replacement;
//   * Range -> 206 with Content-Range, and 416 past the end. A server that
//     answers a range with a whole file and a 200 is a server browsers treat
//     as unable to stream.
//
// The settings service is mocked; only the file on disk is real, and it is
// removed afterwards.
// =============================================================================

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { mkdirSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  getBackgroundVideo: vi.fn(),
}));

vi.mock("@/lib/services/platform-setting.service", () => ({
  getBackgroundVideo: mocks.getBackgroundVideo,
}));

import { GET, HEAD } from "./route";

const TOKEN = "0123456789abcdef01234567";
const SIZE = 256;

const RELATIVE = `public/uploads/site/background-${TOKEN}.mp4`;
const ABSOLUTE = path.join(process.cwd(), RELATIVE);

/** A file whose bytes are recognisably not all the same, so a slice can be checked. */
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

beforeAll(async () => {
  mkdirSync(path.dirname(ABSOLUTE), { recursive: true });
  await mkdir(path.dirname(ABSOLUTE), { recursive: true });
  await import("node:fs/promises").then((fs) => fs.writeFile(ABSOLUTE, payload()));
});

afterAll(async () => {
  await unlink(ABSOLUTE).catch(() => {});
});

describe("GET /api/site/background-video", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBackgroundVideo.mockResolvedValue(active());
  });

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

  it("serves the whole file when the version matches, cacheable for a year", async () => {
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

  it("answers a range with 206 and exactly the bytes asked for", async () => {
    const response = await get(`?v=${TOKEN}`, { Range: "bytes=0-99" });

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes 0-99/${SIZE}`);
    expect(response.headers.get("Content-Length")).toBe("100");

    const body = await bytes(response);
    expect(body.length).toBe(100);
    expect(body).toEqual(payload().subarray(0, 100));
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

  it("416s a range past the end of the file, and says how big it is", async () => {
    const response = await get(`?v=${TOKEN}`, { Range: "bytes=999999999-" });

    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe(`bytes */${SIZE}`);
    expect((await response.text()).length).toBe(0);
  });

  // Someone is holding an address from before the clip was replaced. Serve the
  // CURRENT file so they are not shown a backdrop that no longer exists, but
  // never let that answer be remembered.
  it("serves the current file, uncacheable, for a version that is not the current one", async () => {
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

  it("404s when the row survived but the file did not", async () => {
    mocks.getBackgroundVideo.mockResolvedValue({
      ...active(),
      token: "aaaaaaaaaaaaaaaaaaaaaaaa",
    });

    const response = await get("?v=aaaaaaaaaaaaaaaaaaaaaaaa");

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
  });
});

describe("HEAD /api/site/background-video", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBackgroundVideo.mockResolvedValue(active());
  });

  it("answers with the headers a video element needs and no body", async () => {
    const response = await HEAD(new NextRequest(url()));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(SIZE));
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect((await bytes(response)).length).toBe(0);
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
