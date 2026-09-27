// =============================================================================
// GENHUB - Rebuild the audio-bearing browser-test fixture
//
// Run:  node e2e/make-audio-fixture.mjs
//
// The trimmer has to carry the creator's audio through the cut, and proving that
// needs a source that HAS audio. Getting one is awkward here:
//
//   - Playwright's bundled ffmpeg has no audio encoder at all (its build enables
//     only libvpx and the WebM muxer), so the JPEG-pipe trick that makes
//     fixtures/short.webm cannot produce a soundtrack.
//   - MediaRecorder can — VP8 + Opus in one pass — but the WebM it writes has no
//     `Duration` element, so `video.duration` reads Infinity and the trimmer
//     (correctly) refuses to treat the file as measurable. That is fine for the
//     file a creator exports and useless for the file a creator imports.
//
// So the clip is recorded here in Chromium, and then the one thing Chrome's
// muxer omits is written into the header afterwards: a `Duration` element inside
// the Segment's `Info`. That is a two-field edit of the EBML tree, not a remux —
// the clusters, the codec ids and every byte of media stay exactly as recorded.
//
// The edit only works because MediaRecorder's output has a shape worth relying
// on, and this script refuses to guess when it does not:
//   EBML(31) Segment[unknown size] Info(one-byte size) […] Tracks Cluster…
// A Segment with an unknown size needs no length update when Info grows, and a
// one-byte Info length has room to grow. Anything else aborts with a message
// rather than writing a subtly broken fixture.
// =============================================================================

import { mkdirSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "fixtures", "short-with-audio.webm");

/** Seconds of tone and motion. Long enough to cut a span out of the middle. */
const SECONDS = 4;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;

// -----------------------------------------------------------------------------
// EBML reading
// -----------------------------------------------------------------------------

/** The element id at `pos`, as `{ id, length }`. */
function readId(buf, pos) {
  const first = buf[pos];
  let length = 1;
  while (length <= 4 && !(first & (0x80 >> (length - 1)))) length++;
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + (buf[pos + i] ?? 0);
  return { id, length };
}

/** The size at `pos`, as `{ size, length, unknown }`. */
function readSize(buf, pos) {
  const first = buf[pos];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  const mask = 0xff >> length;
  let value = first & mask;
  let unknown = value === mask;
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) unknown = false;
  }
  return { size: value, length, unknown };
}

/** Encode a size as a VINT of exactly `length` bytes, or null if it will not fit. */
function writeSize(value, length) {
  // The all-ones value is reserved to mean "unknown", so the ceiling is one less.
  if (value >= Math.pow(2, 7 * length) - 1) return null;
  const out = Buffer.alloc(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

/** Find a direct child of the element whose data starts at `start`. */
function findChild(buf, dataStart, dataEnd, wantedId) {
  let pos = dataStart;
  while (pos < dataEnd) {
    const { id, length: idLen } = readId(buf, pos);
    const { size, length: sizeLen, unknown } = readSize(buf, pos + idLen);
    if (id === wantedId) {
      return { at: pos, dataStart: pos + idLen + sizeLen, size, sizeLen, unknown };
    }
    if (unknown) return null;
    pos += idLen + sizeLen + size;
  }
  return null;
}

/**
 * Write a `Duration` into the Segment's `Info`, in TimecodeScale units.
 *
 * Returns a new buffer; nothing before `Info`'s children is moved.
 */
function withDuration(input, durationSeconds) {
  const root = readId(input, 0);
  const rootSize = readSize(input, root.length);
  const segment = findChild(input, root.length + rootSize.length, input.length, ID_SEGMENT);
  if (!segment) throw new Error("no Segment element in the recording");
  if (!segment.unknown) {
    throw new Error(
      "the Segment has a known size, so growing Info would need the Segment length rewritten too"
    );
  }

  const info = findChild(
    input,
    segment.dataStart,
    segment.unknown ? input.length : segment.dataStart + segment.size,
    ID_INFO
  );
  if (!info) throw new Error("no Info element in the recording");

  // MediaRecorder omits Duration entirely; if Chrome ever starts writing one,
  // this script would be patching a file that no longer needs it.
  const existing = findChild(input, info.dataStart, info.dataStart + info.size, ID_DURATION);
  if (existing) throw new Error("the recording already carries a Duration");

  const timecodeScale = (() => {
    const found = findChild(input, info.dataStart, info.dataStart + info.size, ID_TIMECODE_SCALE);
    if (!found) return 1_000_000; // the EBML default
    let value = 0;
    for (let i = 0; i < found.size; i++) value = value * 256 + input[found.dataStart + i];
    return value || 1_000_000;
  })();

  const units = (durationSeconds * 1e9) / timecodeScale;

  // ID (2 bytes) + size (1 byte, an 8-byte value) + the float itself.
  const duration = Buffer.alloc(11);
  duration.writeUInt16BE(ID_DURATION, 0);
  duration[2] = 0x88;
  duration.writeDoubleBE(units, 3);

  const newInfoSize = info.size + duration.length;
  const encoded = writeSize(newInfoSize, info.sizeLen);
  if (!encoded) {
    throw new Error(
      `Info's ${info.sizeLen}-byte size field cannot hold ${newInfoSize} bytes`
    );
  }

  const infoSizeField = info.at + readId(input, info.at).length;
  const insertAt = info.dataStart + info.size;

  return Buffer.concat([
    input.subarray(0, infoSizeField),
    encoded,
    input.subarray(infoSizeField + info.sizeLen, insertAt),
    duration,
    input.subarray(insertAt),
  ]);
}

// -----------------------------------------------------------------------------
// Record it
// -----------------------------------------------------------------------------

/**
 * Unless asked to re-record, this only re-checks the fixture that is committed:
 * recording is not deterministic, and a fixture that changes on every run makes
 * a diff meaningless.
 */
if (process.argv.includes("--verify")) {
  await verify();
  process.exit(0);
}

const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
});
const page = await browser.newPage();
await page.goto("about:blank");

const recorded = await page.evaluate(async (seconds) => {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const ctx = canvas.getContext("2d");
  const stream = canvas.captureStream(30);

  // A steady tone, so a later test can tell "audio survived" from "silence".
  const ctxAudio = new AudioContext();
  const oscillator = ctxAudio.createOscillator();
  oscillator.frequency.value = 440;
  const destination = ctxAudio.createMediaStreamDestination();
  oscillator.connect(destination);
  oscillator.start();
  destination.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
  await ctxAudio.resume();

  const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8,opus" });
  const chunks = [];
  recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
  const stopped = new Promise((resolve) => (recorder.onstop = resolve));

  recorder.start(500);
  const start = performance.now();
  await new Promise((resolve) => {
    const tick = () => {
      const t = (performance.now() - start) / 1000;
      ctx.fillStyle = `hsl(${(t * 60) % 360} 70% 35%)`;
      ctx.fillRect(0, 0, 320, 240);
      ctx.fillStyle = "#fff";
      ctx.fillRect(((t * 80) % 280) | 0, 110, 40, 20);
      if (t > seconds) resolve();
      else requestAnimationFrame(tick);
    };
    tick();
  });
  recorder.stop();
  await stopped;

  const blob = new Blob(chunks, { type: "video/webm" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return { base64: btoa(binary), elapsed: (performance.now() - start) / 1000 };
}, SECONDS);
await browser.close();

const patched = withDuration(Buffer.from(recorded.base64, "base64"), recorded.elapsed);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, patched);

console.log(
  `Wrote ${OUT} (${(statSync(OUT).size / 1024).toFixed(0)} KB) — ` +
    `${recorded.elapsed.toFixed(2)}s of VP8 + Opus, Duration patched in`
);

writeFileSync(
  join(here, "fixtures", "README.md"),
  [
    "# Browser-test fixtures",
    "",
    "Two real, committed clips for the trimmer's browser tests:",
    "",
    "- `short.webm` — 6s, VP8/WebM, no audio, with a true duration in its header.",
    "  Regenerate with `node e2e/make-fixture.mjs`.",
    "- `short-with-audio.webm` — ~4s, VP8 + Opus, with the `Duration` element that",
    "  MediaRecorder omits patched into the EBML header afterwards.",
    "  Regenerate with `node e2e/make-audio-fixture.mjs`.",
    "",
    "Neither is produced by H.264 or AAC: the browser these tests run in is",
    "open-source Chromium, which cannot decode either. See the comments in the",
    "two generator scripts for the full reasoning.",
    "",
  ].join("\n")
);

async function verify() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto("about:blank");
  const bytes = readFileSync(OUT);
  const result = await page.evaluate(async (base64) => {
    const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const blob = new Blob([raw], { type: "video/webm" });
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.src = url;
    video.preload = "metadata";
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error("decode failed"));
    });
    return { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
  }, bytes.toString("base64"));
  await browser.close();
  console.log(`Verified ${OUT}:`, JSON.stringify(result));
}
