// =============================================================================
// GENHUB - A PNG that is really an AVIF is refused at the door
//
// `file.type` picks the stored extension and nothing else, so it is a claim. The
// claim mattered because this app hands its own public uploads to next/image's
// optimiser, which decodes by CONTENT, and Next 14 decodes AVIF with
// sharp/libheif — the path with a critical unauthenticated RCE
// (GHSA-2xp9-vwfh-vxw4). A free account, a file labelled `image/png`, and the
// optimiser does the rest.
//
// Two defences, and this pins both: the upload route refuses a HEIF container
// wearing a non-HEIF name, and canOptimizeImage refuses HEIF keys outright.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isHeifContainer, isHeifExtension } from "@/lib/image-bytes";

const upload = readFileSync(
  join(process.cwd(), "src", "app", "api", "upload", "route.ts"),
  "utf8"
);

/** An ISO-BMFF box header: size, `ftyp`, major brand. */
function ftyp(brand: string): Uint8Array {
  const head = [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70];
  const bytes = [...head, ...brand.split("").map((c) => c.charCodeAt(0))];
  return new Uint8Array([...bytes, ...new Array(16).fill(0)]);
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);

describe("isHeifContainer", () => {
  it("recognises the HEIF brands a browser or a phone produces", () => {
    for (const brand of ["avif", "avis", "heic", "heix", "mif1", "msf1", "hevx"]) {
      expect(isHeifContainer(ftyp(brand)), brand).toBe(true);
    }
  });

  it("does not mistake a real PNG or JPEG for one", () => {
    expect(isHeifContainer(PNG)).toBe(false);
    expect(isHeifContainer(JPEG)).toBe(false);
  });

  it("does not mistake a video container for one", () => {
    // `ftyp` with an MP4 brand is not a HEIF image, and refusing it would only
    // break honest files.
    expect(isHeifContainer(ftyp("isom"))).toBe(false);
    expect(isHeifContainer(ftyp("mp42"))).toBe(false);
  });

  it("is unbothered by a file too short to tell", () => {
    expect(isHeifContainer(new Uint8Array([]))).toBe(false);
    expect(isHeifContainer(new Uint8Array([0x00, 0x00, 0x00, 0x20]))).toBe(false);
  });
});

describe("isHeifExtension", () => {
  it("covers the container extensions, whatever the case", () => {
    expect(isHeifExtension("public/images/a.avif")).toBe(true);
    expect(isHeifExtension("/api/media/public/images/A.HEIC")).toBe(true);
    expect(isHeifExtension("public/images/a.heif")).toBe(true);
    expect(isHeifExtension("public/images/a.jpg")).toBe(false);
    expect(isHeifExtension(null)).toBe(false);
    expect(isHeifExtension(undefined)).toBe(false);
  });
});

describe("the upload route", () => {
  it("checks the bytes before it stores anything", () => {
    const sniff = upload.indexOf("isHeifContainer(buffer)");
    const write = upload.indexOf("storage.bunnycdn.com");

    expect(sniff).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(sniff).toBeLessThan(write);
  });

  it("still accepts an honest HEIC or HEIF photo", () => {
    // "Honest" is what the declaration says, and the declaration can now be the
    // extension as well as the MIME type: a photo library hands a .HEIC over
    // with no type at all, and reading the name there is what stops the route
    // refusing a real iPhone photo. What did NOT move is the check below it —
    // `isHeifContainer` reads the BYTES, so a HEIF wearing a .jpg is refused
    // whichever way it declared itself.
    expect(upload).toContain('ext === ".heic"');
    expect(upload).toContain('ext === ".heif"');
  });

  it("refuses a HEIF name too, not only a mislabelled type", () => {
    // The disguise this file exists to stop is a HEIF anyway; the MIME type was
    // simply the easiest way to write it. The byte check must therefore run for
    // a file that said nothing at all as well — which is the case that was
    // unreachable while an untyped picture was rejected before it got there.
    expect(upload).toContain("if (!declaredHeif && isHeifContainer(buffer))");
    expect(upload).toMatch(/SAID_NOTHING\.test/);
  });
});
