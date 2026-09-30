// =============================================================================
// GENHUB - Shrinking a picture the browser did not type
//
// The step exists for one hard reason: on Vercel a Serverless Function body is
// capped at 4.5 MB, and a modern phone photo is 4-12 MB, so a photo sent at full
// size is refused by the platform BEFORE any route of ours runs. There is no
// app-level limit that can rescue it.
//
// So this gate has to be right, and it was not. `file.type.startsWith("image/")`
// is a claim the picker makes, and on Android the picker frequently makes no
// claim at all — a gallery photo, or one a chat app saved, arrives with `""` or
// `application/octet-stream`. Those files were declared "not a picture", skipped
// the shrink, and went to the server at full size: on a deployment they never
// arrived, and the creator was told the upload failed on a file the picker had
// already accepted.
//
// The rule is now the same one lib/media's classifyFile reads — the extension is
// the second signal — and these tests pin it at the boundary, including the
// cases that must NOT change: a picture that cannot be decoded is handed over
// untouched rather than lost, a video is left alone, and a small photo is not
// re-encoded for nothing.
//
// Canvas and Image are stubs: this is Node, and the point is the decision, not
// the pixels.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { downscaleImage } from "@/lib/image-downscale";

/** The picture size the stub "decodes", and whether it decodes at all. */
let naturalWidth = 4000;
let naturalHeight = 3000;
let decodeFails = false;

/** Bytes the stub canvas hands back — small enough to fit on the first pass. */
let encodedBytes = 40;
/** The type the stub canvas encodes to, recorded so assertions can read it. */
let lastEncodedType = "";

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  set src(_value: string) {
    if (decodeFails) {
      queueMicrotask(() => this.onerror?.());
      return;
    }
    this.naturalWidth = naturalWidth;
    this.naturalHeight = naturalHeight;
    queueMicrotask(() => this.onload?.());
  }
}

const fakeDocument = {
  createElement(tag: string) {
    if (tag !== "canvas") throw new Error(`unexpected element ${tag}`);
    return {
      width: 0,
      height: 0,
      getContext: () => ({
        imageSmoothingEnabled: true,
        imageSmoothingQuality: "high",
        fillStyle: "",
        fillRect: () => {},
        drawImage: () => {},
      }),
      toBlob(callback: (blob: Blob | null) => void, type?: string) {
        lastEncodedType = type || "";
        callback(new Blob([new Uint8Array(encodedBytes)], { type }));
      },
    };
  },
};

beforeEach(() => {
  naturalWidth = 4000;
  naturalHeight = 3000;
  decodeFails = false;
  encodedBytes = 40;
  lastEncodedType = "";
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: () => "blob:stub",
    revokeObjectURL: () => {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A picture of `mb` megabytes, the size a phone actually produces. */
function photo(name: string, type: string, mb = 6): File {
  return new File([new Uint8Array(mb * 1024 * 1024)], name, { type });
}

describe("a picture the browser did not type", () => {
  it("is still recognised from its filename and shrunk", async () => {
    for (const type of ["", "application/octet-stream"]) {
      const source = photo("cover.jpg", type);
      const result = await downscaleImage(source);

      expect(result).not.toBe(source);
      expect(result.size).toBeLessThan(source.size);
      // Re-encoding also gives it a type the server can act on, which is the
      // second half of why this step matters.
      expect(result.type).toBe("image/jpeg");
      expect(result.name).toBe("cover.jpg");
    }
  });

  it("recognises the formats a creator actually brings", async () => {
    // Not a claim about decoding — a BMP and an AVIF both come back re-encoded
    // as JPEG here, which is the point: the picker takes them, so this step has
    // to know they are pictures rather than pass a 6 MB file through unshrunk.
    for (const [name, type] of [
      ["shot.avif", ""],
      ["old.bmp", "image/bmp"],
      ["IMG_9.HEIC", ""],
    ]) {
      const source = new File([new Uint8Array(6 * 1024 * 1024)], name, { type });
      const result = await downscaleImage(source);

      expect(result, name).not.toBe(source);
      expect(result.type, name).toBe("image/jpeg");
    }
  });

  it("passes a TIFF through untouched rather than refusing it", async () => {
    // A TIFF is the one picture no browser can draw, so the crop step is skipped
    // for it upstream — but the file still goes to the server as the creator
    // chose it, which is what "do not refuse it by format" has to mean.
    const source = photo("scan.tiff", "image/tiff");

    expect(await downscaleImage(source)).toBe(source);
  });

  it("keeps a PNG a PNG so transparency survives", async () => {
    const result = await downscaleImage(photo("logo.png", ""));

    expect(result.type).toBe("image/png");
    expect(lastEncodedType).toBe("image/png");
  });

  it("is handed over untouched when the browser cannot decode it", async () => {
    // A HEIC on Chrome lands here: the file is real, the decode is not
    // available, and the honest outcome is the original bytes rather than
    // nothing at all.
    decodeFails = true;
    const source = photo("IMG_0042.HEIC", "");

    expect(await downscaleImage(source)).toBe(source);
  });
});

describe("what must not change", () => {
  it("leaves a photo that is already small exactly as it was chosen", async () => {
    naturalWidth = 800;
    naturalHeight = 600;
    const source = new File([new Uint8Array(100_000)], "cover.jpg", { type: "" });

    // Note what this means downstream: a small photo keeps the type the picker
    // gave it, so the server has to read the extension too. See
    // src/app/api/upload/route.test.ts.
    expect(await downscaleImage(source)).toBe(source);
  });

  it("leaves a video alone", async () => {
    const source = new File([new Uint8Array(8 * 1024 * 1024)], "scene.mp4", {
      type: "video/mp4",
    });

    expect(await downscaleImage(source)).toBe(source);
  });

  it("leaves a file with no extension and no type alone", async () => {
    const source = new File([new Uint8Array(8 * 1024 * 1024)], "download", { type: "" });

    expect(await downscaleImage(source)).toBe(source);
  });

  it("still shrinks a picture that was typed properly", async () => {
    const source = photo("holiday.jpeg", "image/jpeg");
    const result = await downscaleImage(source);

    expect(result).not.toBe(source);
    expect(result.type).toBe("image/jpeg");
    // The app's own extension, never whatever the original name happened to be:
    // the bytes are a JPEG now and the name has to say so.
    expect(result.name).toBe("holiday.jpg");
  });
});
