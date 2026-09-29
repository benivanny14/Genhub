// =============================================================================
// GENHUB - What the device's own probes mean, and what they must NOT say
//
// Two requests separate four failures a browser reports identically, so the
// wording of the verdict IS the diagnosis. Measured on 2026-09-29: a phone that
// had uploaded 192 MB an hour earlier had every later part PUT die in under a
// second with zero bytes acknowledged, and every record said "the connection
// dropped" — which was one of four possible things and possibly not true.
//
// The properties pinned here:
//
//   * an unreachable host is reported FIRST and alone: if the network could not
//     reach the bucket, the write probe's failure is a consequence, not a second
//     cause, and offering both tells the creator two contradictory stories;
//   * a write that was refused BEFORE it was sent (a CORS refusal — `status:
//     null`) is named as the page's address and not as the connection, because
//     those need opposite fixes;
//   * a write the provider actually answered is quoted with its status, because
//     that one is not about the network at all;
//   * nothing here throws on a missing probe, so a broken probe can never be the
//     reason an upload is reported wrongly.
// =============================================================================

import { describe, expect, it } from "vitest";

import { describeProbePair, hostOf } from "@/lib/upload-diagnostics";

const reach = (ok: boolean, ms = 120, error?: string) => ({ ok, ms, error });
const write = (ok: boolean, status: number | null, ms = 200, error?: string) => ({
  ok,
  status,
  ms,
  error,
});

describe("hostOf", () => {
  it("keeps the scheme and host and drops everything a probe must not send", () => {
    // The upload's own signed URL, reduced to the origin to probe: the query
    // string carries a signature that would expire, and the path names an object.
    expect(
      hostOf(
        "https://5492c7dfae50c7be6388a2e6558da365.r2.cloudflarestorage.com/genhub-uploads/incoming/a?X-Amz-Signature=x"
      )
    ).toBe("https://5492c7dfae50c7be6388a2e6558da365.r2.cloudflarestorage.com/");
  });

  it("answers null for something that is not a URL at all", () => {
    expect(hostOf("not a url")).toBeNull();
  });
});

describe("describeProbePair", () => {
  it("blames the network once, and does not also blame the permission", () => {
    const verdict = describeProbePair(
      reach(false, 6_000, "TypeError"),
      write(false, null, 90, "TypeError"),
      "storage host"
    );

    expect(verdict).toContain("could not reach");
    expect(verdict).toContain("TypeError");
    // The write probe's own failure is a CONSEQUENCE of an unreachable host:
    // reported as a second cause it would contradict the first sentence.
    expect(verdict).not.toContain("refused before it was sent");
    // And it names the action, because this is the sentence that reaches a phone.
    expect(verdict).toContain("Wi-Fi");
  });

  it("separates a refused-before-sent request from a provider's own answer", () => {
    const refused = describeProbePair(reach(true), write(false, null, 300, "TypeError"), "storage host");
    expect(refused).toContain("refused before it was sent");
    expect(refused).toContain("CORS");

    const answered = describeProbePair(reach(true), write(false, 403, 400), "storage host");
    expect(answered).toContain("HTTP 403");
    expect(answered).toContain("not by the connection");
  });

  it("does not nominate a cause when only reachability was tested", () => {
    // The live sentence this replaces, seen in a real failure record on
    // 2026-09-29: "...refused for something other than the network — most likely
    // the bucket's CORS policy, which has to name this exact page address." The
    // page's origin WAS named by the policy — checked against the bucket — so the
    // sentence sent the reader to change something that was already right. A GET
    // to the host's root proves a name resolves; it says nothing about whether a
    // PUT will be allowed through, and the three remaining causes look the same
    // from here.
    const verdict = describeProbePair(reach(true, 120), null, "storage host");

    expect(verdict).toContain("reachable");
    expect(verdict).not.toMatch(/most likely/);
    // The honest limit, said out loud rather than filled with a guess.
    expect(verdict).toContain("all look identical from here");
    // And the one step that CAN separate them, named with where to do it.
    expect(verdict).toContain("/creator/upload-check");
  });

  it("says the path works when both probes pass, rather than inventing a fault", () => {
    const verdict = describeProbePair(reach(true, 80), write(true, 200, 250), "storage host");
    expect(verdict).toContain("reachable");
    expect(verdict).toContain("accepts a signed write");
  });

  it("does not throw when a probe is missing", () => {
    expect(() => describeProbePair(null, null, "storage host")).not.toThrow();
    expect(() => describeProbePair(null, write(true, 200), "storage host")).not.toThrow();
  });
});
