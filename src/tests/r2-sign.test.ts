// =============================================================================
// GENHUB - Presigned R2 URLs
//
// The first test in this file is not written by us: it is the worked example in
// the AWS S3 documentation, published with an expected signature. That is the
// point of it — a signature implementation can be wrong in ways that only show
// up as a 403 on a creator's upload, so it is checked against a value somebody
// else computed, not against itself.
//
// The rest are the properties this application depends on: that the URL carries
// no secret, that it authorizes exactly what it says, and that nothing about it
// is decided by the clock the tests cannot control.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  amzDateFrom,
  isR2Configured,
  presign,
  presignR2Put,
  r2Host,
  r2ObjectPath,
  sha256Hex,
  uriEncode,
  type R2Credentials,
} from "@/lib/r2-sign";

// =============================================================================
// The documented vector
// =============================================================================

const AWS_VECTOR = {
  host: "examplebucket.s3.amazonaws.com",
  path: "/test.txt",
  method: "GET",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  expiresInSeconds: 86400,
  date: new Date("2013-05-24T00:00:00Z"),
};

const AWS_EXPECTED_URL =
  "https://examplebucket.s3.amazonaws.com/test.txt" +
  "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
  "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
  "&X-Amz-Date=20130524T000000Z" +
  "&X-Amz-Expires=86400" +
  "&X-Amz-SignedHeaders=host" +
  "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404";

describe("presign reproduces the documented AWS example", () => {
  it("hashes the canonical request to the published value", () => {
    const { canonicalRequest } = presign(AWS_VECTOR);
    expect(sha256Hex(canonicalRequest)).toBe(
      "3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04"
    );
  });

  it("produces the published signature", () => {
    expect(presign(AWS_VECTOR).signature).toBe(
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
    );
  });

  it("produces the published URL, byte for byte", () => {
    expect(presign(AWS_VECTOR).url).toBe(AWS_EXPECTED_URL);
  });

  it("builds the canonical request in the documented order", () => {
    // Seven lines, not six: the canonical headers block is itself newline-
    // terminated, so the join leaves an empty line before the signed-headers
    // list. That is the shape the published hash is taken over.
    const lines = presign(AWS_VECTOR).canonicalRequest.split("\n");
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe("GET");
    expect(lines[1]).toBe("/test.txt");
    expect(lines[3]).toBe(`host:${AWS_VECTOR.host}`);
    expect(lines[4]).toBe("");
    expect(lines[5]).toBe("host");
    expect(lines[6]).toBe("UNSIGNED-PAYLOAD");
  });
});

// =============================================================================
// The encoder
// =============================================================================

describe("uriEncode", () => {
  it("leaves the unreserved set alone", () => {
    expect(uriEncode("aZ09-._~")).toBe("aZ09-._~");
  });

  it("escapes the characters encodeURIComponent forgets", () => {
    // The platform encoder leaves these unescaped; AWS's canonical request does
    // not, and a signature built with the wrong one is refused without saying
    // why.
    expect(uriEncode("!'()*")).toBe("%21%27%28%29%2A");
  });

  it("encodes a space as %20 and never as +", () => {
    expect(uriEncode("a b")).toBe("a%20b");
  });

  it("keeps slashes when they are part of a key, and encodes them when not", () => {
    expect(uriEncode("a/b", false)).toBe("a/b");
    expect(uriEncode("a/b", true)).toBe("a%2Fb");
  });

  it("uses uppercase hex digits", () => {
    expect(uriEncode("ü")).toBe("%C3%BC");
  });
});

// =============================================================================
// Timestamps
// =============================================================================

describe("amzDateFrom", () => {
  it("formats as the canonical request requires", () => {
    expect(amzDateFrom(new Date("2013-05-24T00:00:00Z"))).toBe("20130524T000000Z");
  });

  it("drops milliseconds", () => {
    expect(amzDateFrom(new Date("2026-09-29T13:07:05.995Z"))).toBe("20260929T130705Z");
  });
});

// =============================================================================
// The R2 wrapper
// =============================================================================

const R2: R2Credentials = {
  accountId: "a1b2c3",
  accessKeyId: "key-id",
  secretAccessKey: "secret",
  bucket: "genhub-uploads",
};

const NOW = new Date("2026-09-29T13:00:00Z");

describe("presignR2Put", () => {
  it("addresses the object path-style on R2's S3 endpoint", () => {
    const { url } = presignR2Put(R2, "incoming/video-1", 3600, NOW);
    expect(url.startsWith("https://a1b2c3.r2.cloudflarestorage.com/genhub-uploads/incoming/video-1?")).toBe(true);
    expect(r2Host(R2.accountId)).toBe("a1b2c3.r2.cloudflarestorage.com");
    expect(r2ObjectPath(R2.bucket, "k")).toBe("/genhub-uploads/k");
  });

  it("signs for the auto region R2 expects", () => {
    const { url } = presignR2Put(R2, "incoming/video-1", 3600, NOW);
    expect(url).toContain("%2Fauto%2Fs3%2Faws4_request");
  });

  it("carries the deadline, so the URL dies on its own", () => {
    const { url } = presignR2Put(R2, "incoming/video-1", 900, NOW);
    expect(url).toContain("X-Amz-Expires=900");
    expect(url).toContain("X-Amz-Date=20260929T130000Z");
  });

  it("keeps the secret out of the URL", () => {
    const { url } = presignR2Put(R2, "incoming/video-1", 3600, NOW);
    expect(url).not.toContain(R2.secretAccessKey);
    // The access key id is public by design; the secret never is.
    expect(url).toContain(R2.accessKeyId);
  });

  it("is deterministic for one moment and one object", () => {
    expect(presignR2Put(R2, "k", 60, NOW).url).toBe(presignR2Put(R2, "k", 60, NOW).url);
  });

  it("changes when the object, the method, the deadline, the date or the secret changes", () => {
    const base = presignR2Put(R2, "k", 60, NOW).signature;
    expect(presignR2Put(R2, "k2", 60, NOW).signature).not.toBe(base);
    expect(presignR2Put(R2, "k", 61, NOW).signature).not.toBe(base);
    expect(presignR2Put(R2, "k", 60, new Date("2026-09-29T13:00:01Z")).signature).not.toBe(base);
    expect(presignR2Put({ ...R2, secretAccessKey: "other" }, "k", 60, NOW).signature).not.toBe(base);
    expect(
      presign({
        ...AWS_VECTOR,
        method: "PUT",
      }).signature
    ).not.toBe(presign(AWS_VECTOR).signature);
  });

  it("signs a key with slashes as one path, not three segments", () => {
    const { canonicalRequest } = presignR2Put(R2, "incoming/a/b", 60, NOW);
    expect(canonicalRequest.split("\n")[1]).toBe("/genhub-uploads/incoming/a/b");
  });
});

describe("isR2Configured", () => {
  it("is true only when every part is present", () => {
    expect(isR2Configured(R2)).toBe(true);
    expect(isR2Configured({ ...R2, bucket: "" })).toBe(false);
    expect(isR2Configured({ accountId: "a", bucket: "b" })).toBe(false);
    expect(isR2Configured({})).toBe(false);
  });
});
