// =============================================================================
// GENHUB - The single-PUT upload proxy
//
// Two runtimes and one secret sit between a creator's file and Bunny here, and
// every way that can go wrong is silent from the outside:
//
//   * a token that verifies for the WRONG video id turns a per-video credential
//     into a library-wide one;
//   * a token that verifies after its deadline is one that lives in proxy logs
//     forever;
//   * a Worker that reads the body before authorizing spends a creator's data
//     plan on a request it was always going to refuse;
//   * a Worker that forgets the AccessKey produces a 401 with no body — which is
//     exactly the opaque failure this whole path exists to remove.
//
// So these tests sign real tokens, hand them to the REAL Worker handler (the
// module under worker/bunny-upload is imported, not reimplemented), and check
// what reaches the Bunny call the Worker makes.
// =============================================================================

import { describe, it, expect, vi, afterEach } from "vitest";

const bunny = vi.hoisted(() => ({
  libraryId: "760553",
  apiKey: "test-stream-key",
  uploadProxyUrl: "https://genhub-bunny-upload.example.workers.dev",
  uploadProxySecret: "test-proxy-secret",
  uploadProxyMaxBytes: 100 * 1024 * 1024,
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  return { ...actual, default: { ...actual.default, bunny } };
});

import {
  signUploadProxyToken,
  uploadProxyTokenPayload,
  uploadProxyUrl,
  verifyUploadProxyToken,
} from "@/lib/upload-proxy-token";
import { createUploadProxyTarget, isUploadProxyConfigured } from "@/lib/upload-proxy";
import worker from "../../worker/bunny-upload/index";

const SECRET = "test-proxy-secret";
const VIDEO_ID = "045b5638-6eff-45bb-8ef9-92479ebc3c3b";
const OTHER_VIDEO_ID = "ce2ae11d-0f6a-40e5-a629-7995f97ecaaf";
/** Far enough out that nothing here is racing a real clock. */
const EXPIRES = Math.floor(Date.now() / 1000) + 3_600;

afterEach(() => {
  vi.unstubAllGlobals();
});

// =============================================================================
// The token
// =============================================================================

describe("upload proxy token", () => {
  it("signs what it says it signs, in one versioned shape", () => {
    expect(uploadProxyTokenPayload(VIDEO_ID, EXPIRES)).toBe(`v1:${VIDEO_ID}:${EXPIRES}`);
  });

  it("is deterministic, so the Worker can recompute it rather than store it", async () => {
    const once = await signUploadProxyToken(SECRET, VIDEO_ID, EXPIRES);
    const again = await signUploadProxyToken(SECRET, VIDEO_ID, EXPIRES);

    expect(once).toBe(again);
    // Hex, because the token travels in a URL: 32 bytes is 64 characters.
    expect(once).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies its own token up to the deadline, inclusive", async () => {
    const token = await signUploadProxyToken(SECRET, VIDEO_ID, EXPIRES);

    await expect(
      verifyUploadProxyToken({
        secret: SECRET,
        videoId: VIDEO_ID,
        expiresAt: EXPIRES,
        token,
        nowSeconds: EXPIRES,
      })
    ).resolves.toBe(true);
  });

  it("stops verifying one second past the deadline", async () => {
    const token = await signUploadProxyToken(SECRET, VIDEO_ID, EXPIRES);

    await expect(
      verifyUploadProxyToken({
        secret: SECRET,
        videoId: VIDEO_ID,
        expiresAt: EXPIRES,
        token,
        nowSeconds: EXPIRES + 1,
      })
    ).resolves.toBe(false);
  });

  it("refuses a token minted for a different video, however valid it looks", async () => {
    // The whole limitation of this credential: it can fill ONE reserved slot. A
    // token that verified for any id would authorize uploading over somebody
    // else's video.
    const token = await signUploadProxyToken(SECRET, VIDEO_ID, EXPIRES);

    await expect(
      verifyUploadProxyToken({
        secret: SECRET,
        videoId: OTHER_VIDEO_ID,
        expiresAt: EXPIRES,
        token,
        nowSeconds: EXPIRES - 10,
      })
    ).resolves.toBe(false);
  });

  it("refuses a token that was altered by one character", async () => {
    const token = await signUploadProxyToken(SECRET, VIDEO_ID, EXPIRES);
    const tampered = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;

    await expect(
      verifyUploadProxyToken({
        secret: SECRET,
        videoId: VIDEO_ID,
        expiresAt: EXPIRES,
        token: tampered,
        nowSeconds: EXPIRES - 10,
      })
    ).resolves.toBe(false);
  });

  it("refuses a token signed with a different secret", async () => {
    const token = await signUploadProxyToken("some-other-deployment", VIDEO_ID, EXPIRES);

    await expect(
      verifyUploadProxyToken({
        secret: SECRET,
        videoId: VIDEO_ID,
        expiresAt: EXPIRES,
        token,
        nowSeconds: EXPIRES - 10,
      })
    ).resolves.toBe(false);
  });

  it("refuses an empty secret rather than accepting anything", async () => {
    // An unset secret must fail closed. HMAC with an empty key would happily
    // "verify" a token that anybody can forge, which is worse than refusing.
    await expect(
      verifyUploadProxyToken({
        secret: "",
        videoId: VIDEO_ID,
        expiresAt: EXPIRES,
        token: "anything",
        nowSeconds: EXPIRES - 10,
      })
    ).resolves.toBe(false);

    await expect(
      verifyUploadProxyToken({
        secret: SECRET,
        videoId: VIDEO_ID,
        expiresAt: EXPIRES,
        token: "",
        nowSeconds: EXPIRES - 10,
      })
    ).resolves.toBe(false);
  });

  it("tolerates an upper-case hex token, since a proxy may re-case a query string", async () => {
    const token = await signUploadProxyToken(SECRET, VIDEO_ID, EXPIRES);

    await expect(
      verifyUploadProxyToken({
        secret: SECRET,
        videoId: VIDEO_ID,
        expiresAt: EXPIRES,
        token: token.toUpperCase(),
        nowSeconds: EXPIRES - 10,
      })
    ).resolves.toBe(true);
  });
});

describe("the URL the browser is handed", () => {
  it("carries the video, the deadline and the signature", async () => {
    const token = await signUploadProxyToken(SECRET, VIDEO_ID, EXPIRES);
    const url = new URL(
      uploadProxyUrl({
        baseUrl: "https://genhub-bunny-upload.example.workers.dev",
        videoId: VIDEO_ID,
        expiresAt: EXPIRES,
        token,
      })
    );

    expect(url.origin).toBe("https://genhub-bunny-upload.example.workers.dev");
    expect(url.searchParams.get("videoId")).toBe(VIDEO_ID);
    expect(url.searchParams.get("expires")).toBe(String(EXPIRES));
    // In the QUERY STRING rather than a header on purpose: the Worker has to be
    // able to authorize before it reads a body it would otherwise have to carry.
    expect(url.searchParams.get("sig")).toBe(token);
  });

  it("keeps a base path, so the Worker can live under a route of ours", async () => {
    const url = new URL(
      uploadProxyUrl({
        baseUrl: "https://genhub.co.tz/api/bunny-upload",
        videoId: VIDEO_ID,
        expiresAt: EXPIRES,
        token: "abc",
      })
    );

    expect(url.pathname).toBe("/api/bunny-upload");
  });
});

// =============================================================================
// What the server hands the browser
// =============================================================================

describe("the upload target the sign-in response carries", () => {
  it("is absent — not broken — until the proxy is configured", async () => {
    const saved = bunny.uploadProxyUrl;
    bunny.uploadProxyUrl = "";
    try {
      expect(isUploadProxyConfigured()).toBe(false);
      // Null is what makes the client take the resumable path, so this is the
      // switch that lets the whole feature ship before a Worker exists.
      await expect(createUploadProxyTarget(VIDEO_ID)).resolves.toBeNull();
    } finally {
      bunny.uploadProxyUrl = saved;
    }
  });

  it("is absent when only ONE half of the configuration is present", async () => {
    const saved = bunny.uploadProxySecret;
    bunny.uploadProxySecret = "";
    try {
      // A Worker that cannot verify a token this server never signed would
      // answer 401 to every upload; better to keep sending bytes the way that
      // already works.
      expect(isUploadProxyConfigured()).toBe(false);
      await expect(createUploadProxyTarget(VIDEO_ID)).resolves.toBeNull();
    } finally {
      bunny.uploadProxySecret = saved;
    }
  });

  it("carries a token the Worker will accept, and the size ceiling", async () => {
    const target = await createUploadProxyTarget(VIDEO_ID);
    expect(target).not.toBeNull();

    const url = new URL(target!.url);
    const token = url.searchParams.get("sig") || "";
    const expiresAt = Number(url.searchParams.get("expires"));

    // The two halves of the feature, checked against each other rather than
    // each against itself: the server signs, the Worker's own verifier accepts.
    await expect(
      verifyUploadProxyToken({
        secret: SECRET,
        videoId: url.searchParams.get("videoId") || "",
        expiresAt,
        token,
        nowSeconds: Math.floor(Date.now() / 1000),
      })
    ).resolves.toBe(true);

    expect(target!.maxBytes).toBe(100 * 1024 * 1024);
    // An hour: far longer than the wait between reserving a slot and sending
    // bytes, far shorter than the 24h the resumable authorization allows —
    // because unlike that one, this token sits in a URL a proxy will log.
    expect(expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3_500);
    expect(expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 3_600);
  });

  it("honours a shorter lifetime when one is asked for", async () => {
    const target = await createUploadProxyTarget(VIDEO_ID, 60);
    const expiresAt = Number(new URL(target!.url).searchParams.get("expires"));

    expect(expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 60);
  });
});

// =============================================================================
// The Worker itself
// =============================================================================
// The real handler, given real Requests, with only the outgoing Bunny call
// stubbed. What it does with an unauthorized request, an oversized one, and a
// good one is the part that cannot be checked from anywhere else.
// =============================================================================

const LIBRARY = "760553";
const BUNNY_KEY = "bunny-management-key";

const env = {
  BUNNY_STREAM_LIBRARY_ID: LIBRARY,
  BUNNY_STREAM_API_KEY: BUNNY_KEY,
  BUNNY_UPLOAD_PROXY_SECRET: SECRET,
  ALLOWED_ORIGINS: "https://genhub-two.vercel.app,http://localhost:3000",
};

const ORIGIN = "https://genhub-two.vercel.app";
const WORKER_URL = "https://genhub-bunny-upload.example.workers.dev";

/** A signed URL for one video, exactly as the sign-in response would build it. */
async function signedUrl(videoId = VIDEO_ID, expiresAt = EXPIRES): Promise<string> {
  const token = await signUploadProxyToken(SECRET, videoId, expiresAt);
  return uploadProxyUrl({ baseUrl: WORKER_URL, videoId, expiresAt, token });
}

/** One recorded call to Bunny, with its body read back as text. */
interface BunnyCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  streamed: boolean;
}

/**
 * Stand in for Bunny, and record what was sent.
 *
 * `streamed` matters: the Worker is supposed to hand `request.body` straight to
 * fetch, so a 90 MB upload costs kilobytes of memory instead of 90. Buffering it
 * would still pass every other check here and fall over in production.
 */
function stubBunny(status = 201, body = '{"ok":true}'): BunnyCall[] {
  const calls: BunnyCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const streamed = typeof (init.body as ReadableStream | undefined)?.getReader === "function";
      calls.push({
        url,
        method: init.method || "GET",
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body ? await new Response(init.body as BodyInit).text() : "",
        streamed,
      });
      return new Response(body, { status });
    })
  );
  return calls;
}

describe("the upload proxy Worker", () => {
  it("answers a preflight for an allowed origin, and echoes rather than wildcards", async () => {
    const response = await worker.fetch(
      new Request(WORKER_URL, {
        method: "OPTIONS",
        headers: { Origin: ORIGIN, "Access-Control-Request-Method": "PUT" },
      }),
      env
    );

    expect(response.status).toBe(204);
    // Echoed, not `*`: a wildcard is a standing invitation to call this Worker
    // from anywhere, and the token would then be the only thing in the way.
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.headers.get("access-control-allow-methods")).toContain("PUT");
  });

  it("does not authorize a browser it does not know", async () => {
    const response = await worker.fetch(
      new Request(WORKER_URL, {
        method: "OPTIONS",
        headers: { Origin: "https://someone-elses-site.example" },
      }),
      env
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers a liveness check without naming a secret", async () => {
    const response = await worker.fetch(new Request(WORKER_URL), env);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      ok: true,
      libraryConfigured: true,
      secretConfigured: true,
    });
    // An operator checks this from a terminal; it must not print the key it is
    // checking for.
    expect(text).not.toContain(BUNNY_KEY);
    expect(text).not.toContain(SECRET);
  });

  it("refuses a request with no token before touching the body", async () => {
    const calls = stubBunny();

    const response = await worker.fetch(
      new Request(`${WORKER_URL}?videoId=${VIDEO_ID}`, { method: "PUT", body: "bytes" }),
      env
    );

    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("refuses a token minted for a different video", async () => {
    // The failure that matters most: a valid token pointed at somebody else's
    // slot must not fill it.
    const calls = stubBunny();
    const url = await signedUrl(VIDEO_ID);

    const response = await worker.fetch(
      new Request(url.replace(VIDEO_ID, OTHER_VIDEO_ID), { method: "PUT", body: "bytes" }),
      env
    );

    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("refuses a token whose deadline has passed", async () => {
    const calls = stubBunny();
    const past = Math.floor(Date.now() / 1000) - 60;
    const url = await signedUrl(VIDEO_ID, past);

    const response = await worker.fetch(
      new Request(url, { method: "PUT", body: "bytes" }),
      env
    );

    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("sends the bytes on with the library key attached, streamed", async () => {
    const calls = stubBunny(201, '{"status":200,"message":"OK"}');

    const response = await worker.fetch(
      new Request(await signedUrl(), {
        method: "PUT",
        headers: { Origin: ORIGIN, "Content-Type": "application/octet-stream" },
        body: "the-whole-file",
      }),
      env
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `https://video.bunnycdn.com/library/${LIBRARY}/videos/${VIDEO_ID}`
    );
    expect(calls[0].method).toBe("PUT");
    // The entire reason the Worker exists: the key is added here and never
    // reaches a browser.
    expect(calls[0].headers.AccessKey).toBe(BUNNY_KEY);
    expect(calls[0].headers["Content-Type"]).toBe("application/octet-stream");
    expect(calls[0].body).toBe("the-whole-file");
    expect(calls[0].streamed).toBe(true);

    // Bunny's own answer is passed through, and the response is CORS-decorated
    // so the browser can read the status rather than reporting a network error.
    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    await expect(response.text()).resolves.toBe('{"status":200,"message":"OK"}');
  });

  it("passes a refusal from Bunny through instead of turning it into a success", async () => {
    stubBunny(400, '{"status":400,"message":"Invalid file size."}');

    const response = await worker.fetch(
      new Request(await signedUrl(), { method: "PUT", body: "bytes" }),
      env
    );

    expect(response.status).toBe(400);
  });

  it("refuses a body over the ceiling by name, before sending any of it", async () => {
    const calls = stubBunny();

    const response = await worker.fetch(
      new Request(await signedUrl(), {
        method: "PUT",
        // What a browser sends for a File whose size it knows.
        headers: { "Content-Length": "16" },
        body: "0123456789ABCDEF",
      }),
      { ...env, MAX_UPLOAD_BYTES: "10" }
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("sent in pieces"),
    });
    expect(calls).toHaveLength(0);
  });

  it("forwards a request that declares no size, rather than refusing a good one", async () => {
    // The honest shape of the check above: a nicer message, not the ceiling.
    // Cloudflare refuses a body over the plan limit before this Worker ever runs
    // and Bunny has its own limit behind that, so a request with no
    // Content-Length cannot be refused here without also refusing transfers that
    // are perfectly fine. A browser uploading a File always sends the header.
    const calls = stubBunny();

    const response = await worker.fetch(
      new Request(await signedUrl(), { method: "PUT", body: "0123456789ABCDEF" }),
      { ...env, MAX_UPLOAD_BYTES: "10" }
    );

    expect(response.status).toBe(201);
    expect(calls).toHaveLength(1);
  });

  it("refuses anything that is not a PUT", async () => {
    for (const method of ["DELETE", "POST", "PATCH"]) {
      const response = await worker.fetch(
        new Request(WORKER_URL, { method, headers: { Origin: ORIGIN } }),
        env
      );
      // Not 404: a delete that reached Bunny's API with this Worker's key would
      // be a very bad way to learn that the method was not checked.
      expect(response.status).toBe(405);
    }
  });

  it("answers 503 rather than forwarding without its own credentials", async () => {
    const calls = stubBunny();

    const response = await worker.fetch(
      new Request(await signedUrl(), { method: "PUT", body: "bytes" }),
      { ...env, BUNNY_STREAM_API_KEY: "" }
    );

    expect(response.status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});
