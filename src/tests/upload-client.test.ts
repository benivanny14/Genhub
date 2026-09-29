// =============================================================================
// GENHUB - What the browser adds to a failure report
//
// The report is written by the one part of the system that can see the transfer,
// and it is written while that transfer is failing. So the two properties worth
// pinning here are about not making things worse:
//
//   * the connection snapshot never throws and never invents a value — a browser
//     without the Network Information API answers null, and one whose connection
//     object misbehaves answers null too rather than taking the whole report
//     down with it; and
//   * the timings travel as numbers or as null. An empty array would read as
//     "one attempt that lasted no time", which is a claim the uploader is not
//     making.
//
// The environment is node, not a browser: `navigator` is whatever the test
// stubs, which is exactly the variation these functions have to survive.
// =============================================================================

import { describe, it, expect, vi, afterEach } from "vitest";
import { readNetworkSnapshot, describeUploadFailure } from "@/lib/upload-client";
import { VideoUploadError } from "@/lib/upload-error";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readNetworkSnapshot", () => {
  it("reads what the browser knows about its link", () => {
    vi.stubGlobal("navigator", {
      connection: { effectiveType: "3g", downlink: 0.4, rtt: 350.6 },
    });

    // Rounded, because a report is read by a person: 350.6 ms is 351.
    expect(readNetworkSnapshot()).toEqual({
      connectionType: "3g",
      downlinkMbps: 0.4,
      rttMs: 351,
    });
  });

  it("answers with nothing at all, rather than guessing, when the API is absent", () => {
    // Safari and Firefox do not implement it. A null here means "not offered",
    // which is a fact; a default would be an invented one.
    vi.stubGlobal("navigator", {});

    expect(readNetworkSnapshot()).toEqual({
      connectionType: null,
      downlinkMbps: null,
      rttMs: null,
    });
  });

  it("never throws, because it runs while a failure is already being reported", () => {
    // A getter that throws would otherwise spread itself into the payload
    // construction and lose the report entirely — Bunny's status, the offset and
    // the slot included. The connection detail is the optional part.
    vi.stubGlobal("navigator", {
      get connection(): never {
        throw new Error("no network information here");
      },
    });

    expect(readNetworkSnapshot()).toEqual({
      connectionType: null,
      downlinkMbps: null,
      rttMs: null,
    });
  });
});

describe("describeUploadFailure", () => {
  it("carries the per-attempt timings as numbers", () => {
    const error = new VideoUploadError("NETWORK", "The connection dropped during upload.");
    error.attemptMs = [12, 9, 14];

    expect(describeUploadFailure(error).attemptMs).toEqual([12, 9, 14]);
  });

  it("sends null rather than an empty list when no attempt was timed", () => {
    const missing = new VideoUploadError("NETWORK", "The connection dropped during upload.");
    expect(describeUploadFailure(missing).attemptMs).toBeNull();

    // An empty array would say "attempts were measured and there were none",
    // which is a different statement from "nothing was measured".
    missing.attemptMs = [];
    expect(describeUploadFailure(missing).attemptMs).toBeNull();
  });

  it("still reports a failure that is not one of ours", () => {
    // A thrown string, a browser error, anything: the report exists so the
    // incident leaves a trace, and it must not depend on the shape of what
    // happened.
    const report = describeUploadFailure(new Error("boom"), { fileName: "scene.mp4" });

    expect(report).toMatchObject({
      code: "UNKNOWN",
      message: "boom",
      fileName: "scene.mp4",
      attemptMs: null,
    });
  });
});
