// =============================================================================
// GENHUB - What the picture door refuses, and what it must not
//
// The cover, avatar and KYC pickers all end at uploadImage, and its first line
// used to be `file.type.startsWith("image/")`. That is the browser's CLAIM about
// a file, and on a phone it is routinely absent: a photo from the gallery, a
// picture saved by a chat app, anything the document provider never indexed
// arrives as `""` or `application/octet-stream`. Real pictures were refused with
// "Please choose an image file" — the cover photo that would not upload — and the
// file's NAME is the signal that is actually right on Android (see classifyFile
// in lib/media, which is where the two lists live).
//
// Pinned here rather than left to the picker's `accept`, because `accept` only
// decides what a picker OFFERS; it says nothing about what comes back.
// =============================================================================

import { describe, it, expect } from "vitest";
import { imageUploadRefusal } from "@/lib/upload-client";
import { IMAGE_EXTENSIONS } from "@/lib/media";

/** A file as the picker hands it over: a name and whatever MIME it claimed. */
const picked = (name: string, type: string) => ({ name, type });

describe("imageUploadRefusal", () => {
  it("accepts a picture the picker could not give a type", () => {
    // The Android measurement this was written from: a real JPEG whose provider
    // reported no MIME at all, and the same file arriving as octet-stream.
    expect(imageUploadRefusal(picked("IMG_20260930_1042.jpg", ""))).toBeNull();
    expect(
      imageUploadRefusal(picked("IMG_20260930_1042.jpg", "application/octet-stream"))
    ).toBeNull();
  });


  it("accepts an iPhone's HEIC photo, whatever the picker called it", () => {
    // HEIC is what a phone produces and what the upload route stores; the real
    // bug was a picker filtered to JPEG/PNG/WebP hiding these files entirely.
    expect(imageUploadRefusal(picked("IMG_0001.HEIC", "image/heic"))).toBeNull();
    expect(imageUploadRefusal(picked("IMG_0001.HEIC", ""))).toBeNull();
    expect(imageUploadRefusal(picked("photo.jpeg", "image/jpeg"))).toBeNull();
    expect(imageUploadRefusal(picked("shot.webp", ""))).toBeNull();
  });

  it("refuses a video, by type or by extension", () => {
    expect(imageUploadRefusal(picked("clip.mp4", "video/mp4"))).not.toBeNull();
    expect(imageUploadRefusal(picked("clip.mov", ""))).not.toBeNull();
  });

  it("refuses a captions file, which has its own door", () => {
    expect(imageUploadRefusal(picked("scene.vtt", "text/vtt"))).not.toBeNull();
  });

  it("refuses a file that says nothing about what it is", () => {
    // The other half of trusting the extension: no type AND no name to read has
    // told us nothing, so the file is not sent anywhere to fail.
    expect(imageUploadRefusal(picked("blob", ""))).not.toBeNull();
    expect(imageUploadRefusal(picked("download", "application/octet-stream"))).not.toBeNull();
  });

  it("names what IS accepted, so the refusal is actionable", () => {
    // "Please choose an image file" told a creator holding a photo that their
    // photo was not a photo. The sentence names the types instead — and it names
    // them as "any kind", because the rule is now "is this a picture" rather
    // than "is this one of the three formats we happen to think of".
    const message = imageUploadRefusal(picked("clip.mp4", "video/mp4"));
    expect(message).toMatch(/any kind/);
    expect(message).toMatch(/JPEG/);
    expect(message).toMatch(/PNG|HEIC/);
    expect(message).toMatch(/HEIC/);
  });

  it("takes every picture format the app offers in its pickers", () => {
    // One list, read by the picker, the classifier and the server: a format that
    // is offered must never be refused by the code that reads it back.
    for (const ext of IMAGE_EXTENSIONS) {
      expect(imageUploadRefusal(picked(`photo.${ext}`, "")), ext).toBeNull();
    }
  });
});
