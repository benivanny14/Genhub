// =============================================================================
// GENHUB - Bounded request bodies
//
// The guarantee under test is the one a route handler had no way to state: a
// body larger than the cap is never buffered, and the caller still gets the same
// value the `.catch(() => …)` it replaced would have produced.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readJsonBody, MAX_JSON_BODY_BYTES } from "@/lib/request-body";

/** A POST with a real string body — `Request` sets Content-Length for us. */
function jsonRequest(body: string, headers?: Record<string, string>): Request {
  return new Request("http://genhub.test/api/thing", {
    method: "POST",
    body,
    headers,
  });
}

/** A request whose body arrives as a stream, so there is no Content-Length. */
function streamRequest(chunks: string[]): Request {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request("http://genhub.test/api/thing", {
    method: "POST",
    body: stream,
    // @ts-expect-error — duplicating a stream body needs the duplex flag.
    duplex: "half",
  });
}

describe("readJsonBody", () => {
  it("parses a well-formed body", async () => {
    const parsed = await readJsonBody(jsonRequest(JSON.stringify({ hello: "world" })));
    expect(parsed).toEqual({ hello: "world" });
  });

  it("returns the caller's fallback for a malformed body", async () => {
    expect(await readJsonBody(jsonRequest("{not json"), {})).toEqual({});
    expect(await readJsonBody(jsonRequest("{not json"))).toBeNull();
  });

  it("returns the fallback when Content-Length already exceeds the cap", async () => {
    const big = JSON.stringify({ blob: "x".repeat(MAX_JSON_BODY_BYTES + 100) });
    const parsed = await readJsonBody(jsonRequest(big), "FALLBACK");
    expect(parsed).toBe("FALLBACK");
  });

  it("returns the fallback when a chunked body grows past the cap", async () => {
    // No Content-Length, so the cap has to be enforced during the read.
    const chunks = ["{\"blob\":\"", "x".repeat(MAX_JSON_BODY_BYTES + 1), "\"}"];
    const parsed = await readJsonBody(streamRequest(chunks), "FALLBACK");
    expect(parsed).toBe("FALLBACK");
  });

  it("honours a custom, smaller ceiling", async () => {
    const body = JSON.stringify({ note: "a".repeat(50) });
    expect(await readJsonBody(jsonRequest(body), "BIG", 16)).toBe("BIG");
    expect(await readJsonBody(jsonRequest(body), "BIG", 4096)).toEqual({
      note: "a".repeat(50),
    });
  });

  it("treats an empty body as the fallback rather than an error", async () => {
    const empty = new Request("http://genhub.test/api/thing", { method: "POST", body: "" });
    expect(await readJsonBody(empty, {})).toEqual({});
  });
});
