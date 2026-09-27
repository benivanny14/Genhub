// =============================================================================
// GENHUB - Rebuild the H.264/MP4 browser-test fixture
//
// Run:  node e2e/make-mp4-fixture.mjs
//
// The trimmer's fast path now reads MP4 as well as WebM, so the tests need a
// real H.264 clip in an MP4 — the shape a creator's phone actually produces.
//
// Producing one here is awkward, and worth explaining, because two obvious
// routes are closed:
//
//   - Playwright's bundled ffmpeg ships only the VP8 encoder and the WebM
//     muxer: no H.264 encoder, no MP4 muxer.
//   - A browser's MediaRecorder CAN write `video/mp4;codecs=avc1`, but it
//     writes a FRAGMENTED mp4 (a `moov` with empty tables plus `moof`
//     fragments). A phone writes a CLASSIC mp4, with the sample tables filled
//     in, and that is the shape this fixture must have if the test is to mean
//     anything.
//
// So the picture is encoded in Chromium with WebCodecs' H.264 encoder — which
// this Chromium does have — and muxed here, in Node, into a classic MP4. The
// avcC record the encoder hands back is carried straight into the sample entry,
// so the file is a genuine, decodable H.264/MP4, not a stub.
//
// The result is committed (e2e/fixtures/short-h264.mp4); this script exists so
// it can be regenerated rather than being an unexplained binary.
// =============================================================================

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "fixtures", "short-h264.mp4");
const OUT_FRAGMENTED = join(here, "fixtures", "short-h264-fragmented.mp4");

/** 6 seconds at 30fps, matching the WebM fixture so the specs share numbers. */
const SECONDS = 6;
const FPS = 30;
const WIDTH = 320;
const HEIGHT = 240;
const FRAMES = SECONDS * FPS;
/** A keyframe every two seconds — what a phone encoder roughly does. */
const KEYFRAME_EVERY = 2 * FPS;

// -----------------------------------------------------------------------------
// Byte helpers
// -----------------------------------------------------------------------------

const u8 = (value) => new Uint8Array([value & 0xff]);

const u16 = (value) => {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value);
  return bytes;
};

const u32 = (value) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0);
  return bytes;
};

const u64 = (value) => {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, Math.floor(value / 0x100000000));
  view.setUint32(4, value >>> 0);
  return bytes;
};

const ascii = (text) => new Uint8Array([...text].map((character) => character.charCodeAt(0)));

const zeros = (count) => new Uint8Array(count);

const concat = (parts) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** A box, with its 32-bit size filled in. */
const box = (type, ...parts) => {
  const body = concat(parts);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(ascii(type), 4);
  out.set(body, 8);
  return out;
};

/** A "full box", which carries a version and 24 bits of flags first. */
const fullBox = (type, version, flags, ...parts) =>
  box(type, u8(version), u8((flags >> 16) & 0xff), u8((flags >> 8) & 0xff), u8(flags), ...parts);

/** The identity display matrix every track carries. */
const unityMatrix = concat([
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x40000000),
]);

// -----------------------------------------------------------------------------
// The classic MP4
// -----------------------------------------------------------------------------

/**
 * Mux encoded H.264 samples into a classic (non-fragmented) MP4.
 *
 * The media data comes first and the index (`moov`) after it, which is the
 * opposite of a "faststart" file but is what a plain muxer produces: it lets
 * every chunk offset be known before the tables that state them are written.
 */
function buildClassicMp4({ samples, description, timescale, width, height, durations }) {
  const sampleCount = samples.length;

  const ftyp = box(
    "ftyp",
    ascii("isom"),
    u32(512),
    ascii("isom"),
    ascii("iso2"),
    ascii("avc1"),
    ascii("mp41")
  );

  const sizes = samples.map((sample) => sample.length);
  const mdat = box("mdat", concat(samples));
  // Where the media actually starts: past ftyp and mdat's own header.
  const chunkOffset = ftyp.length + 8;

  const totalTicks = durations.reduce((sum, value) => sum + value, 0);
  const durationMs = Math.round((totalTicks / timescale) * 1000);

  const mvhd = fullBox(
    "mvhd",
    0,
    0,
    u32(0),
    u32(0),
    u32(1000),
    u32(durationMs),
    u32(0x00010000),
    u16(0x0100),
    u16(0),
    u32(0),
    u32(0),
    unityMatrix,
    zeros(24),
    u32(2)
  );

  const tkhd = fullBox(
    "tkhd",
    0,
    7,
    u32(0),
    u32(0),
    u32(1),
    u32(0),
    u32(durationMs),
    zeros(8),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    unityMatrix,
    u32(width << 16),
    u32(height << 16)
  );

  const mdhd = fullBox(
    "mdhd",
    0,
    0,
    u32(0),
    u32(0),
    u32(timescale),
    u32(totalTicks),
    // "und" (undetermined), packed per the MP4 language code.
    u16(0x55c4),
    u16(0)
  );

  const hdlr = fullBox("hdlr", 0, 0, u32(0), ascii("vide"), zeros(12), ascii("VideoHandler\0"));
  const vmhd = fullBox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0));
  const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));

  const avc1 = box(
    "avc1",
    zeros(6),
    u16(1), // data_reference_index
    u16(0),
    u16(0),
    zeros(12),
    u16(width),
    u16(height),
    u32(0x00480000), // 72dpi horizontal
    u32(0x00480000), // 72dpi vertical
    u32(0),
    u16(1), // frame_count
    zeros(32), // compressorname
    u16(0x0018),
    u16(0xffff),
    box("avcC", description)
  );
  const stsd = fullBox("stsd", 0, 0, u32(1), avc1);

  // Every sample has its own duration here; a real encoder emits a uniform
  // cadence, but stating each one keeps the table honest either way.
  const sttsEntries = [];
  for (let i = 0; i < durations.length; ) {
    let run = 1;
    while (i + run < durations.length && durations[i + run] === durations[i]) run++;
    sttsEntries.push(u32(run), u32(durations[i]));
    i += run;
  }
  const stts = fullBox("stts", 0, 0, u32(sttsEntries.length / 2), ...sttsEntries);

  // One chunk holding every sample: legal, and the simplest correct table.
  const stsc = fullBox("stsc", 0, 0, u32(1), u32(1), u32(sampleCount), u32(1));
  const stsz = fullBox("stsz", 0, 0, u32(0), u32(sampleCount), ...sizes.map(u32));
  const stco = fullBox("stco", 0, 0, u32(1), u32(chunkOffset));

  const keyframes = samples
    .map((_, index) => index + 1)
    .filter((_, index) => index % KEYFRAME_EVERY === 0);
  const stss = fullBox("stss", 0, 0, u32(keyframes.length), ...keyframes.map(u32));

  const stbl = box("stbl", stsd, stts, stsc, stsz, stco, stss);
  const minf = box("minf", vmhd, dinf, stbl);
  const mdia = box("mdia", mdhd, hdlr, minf);
  const trak = box("trak", tkhd, mdia);
  const moov = box("moov", mvhd, trak);

  return concat([ftyp, mdat, moov]);
}

/**
 * Mux the same samples the OTHER way, as a fragmented MP4.
 *
 * The tables in `moov` are present but empty, and the media is described by a
 * `moof`/`traf`/`trun` fragment instead. This is the shape a browser's
 * MediaRecorder writes, and the reader has to handle it as well as the classic
 * one — so a fixture in this shape is generated too, rather than trusting the
 * reader's fragment branch to be correct by inspection.
 */
function buildFragmentedMp4({ samples, description, timescale, width, height, durations }) {
  const sampleCount = samples.length;
  const totalTicks = durations.reduce((sum, value) => sum + value, 0);
  const durationMs = Math.round((totalTicks / timescale) * 1000);

  const ftyp = box(
    "ftyp",
    ascii("isom"),
    u32(512),
    ascii("isom"),
    ascii("iso2"),
    ascii("avc1"),
    ascii("mp41")
  );

  const mvhd = fullBox(
    "mvhd",
    0,
    0,
    u32(0),
    u32(0),
    u32(1000),
    u32(durationMs),
    u32(0x00010000),
    u16(0x0100),
    u16(0),
    u32(0),
    u32(0),
    unityMatrix,
    zeros(24),
    u32(2)
  );

  const tkhd = fullBox(
    "tkhd",
    0,
    7,
    u32(0),
    u32(0),
    u32(1),
    u32(0),
    u32(durationMs),
    zeros(8),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    unityMatrix,
    u32(width << 16),
    u32(height << 16)
  );

  const mdhd = fullBox(
    "mdhd",
    0,
    0,
    u32(0),
    u32(0),
    u32(timescale),
    u32(totalTicks),
    u16(0x55c4),
    u16(0)
  );

  const hdlr = fullBox("hdlr", 0, 0, u32(0), ascii("vide"), zeros(12), ascii("VideoHandler\0"));
  const vmhd = fullBox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0));
  const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));

  const avc1 = box(
    "avc1",
    zeros(6),
    u16(1),
    u16(0),
    u16(0),
    zeros(12),
    u16(width),
    u16(height),
    u32(0x00480000),
    u32(0x00480000),
    u32(0),
    u16(1),
    zeros(32),
    u16(0x0018),
    u16(0xffff),
    box("avcC", description)
  );
  const stsd = fullBox("stsd", 0, 0, u32(1), avc1);
  // Present but empty: in a fragmented file every table lives in the fragments.
  const stbl = box(
    "stbl",
    stsd,
    fullBox("stts", 0, 0, u32(0)),
    fullBox("stsc", 0, 0, u32(0)),
    fullBox("stsz", 0, 0, u32(0), u32(0)),
    fullBox("stco", 0, 0, u32(0))
  );
  const minf = box("minf", vmhd, dinf, stbl);
  const mdia = box("mdia", mdhd, hdlr, minf);
  const trak = box("trak", tkhd, mdia);
  // The fragment defaults, which this fragment does not actually rely on.
  const trex = fullBox("trex", 0, 0, u32(1), u32(1), u32(1), u32(0), u32(0));
  const moov = box("moov", mvhd, trak, box("mvex", trex));

  const mfhd = fullBox("mfhd", 0, 0, u32(1));
  // default-base-is-moof: the data offset is relative to this moof's start.
  const tfhd = fullBox("tfhd", 0, 0x020000, u32(1));
  const tfdt = fullBox("tfdt", 1, 0, u64(0));

  const trun = (dataOffset) => {
    const flags =
      0x000001 | // data-offset-present
      0x000100 | // sample-duration-present
      0x000200 | // sample-size-present
      0x000400; // sample-flags-present
    const parts = [u32(sampleCount), u32(dataOffset)];
    for (let index = 0; index < sampleCount; index++) {
      const isKey = index % KEYFRAME_EVERY === 0;
      parts.push(u32(durations[index]));
      parts.push(u32(samples[index].length));
      // sample_depends_on=2 for a key frame, 1 plus the non-sync bit otherwise.
      parts.push(u32(isKey ? 0x02000000 : 0x01010000));
    }
    return fullBox("trun", 0, flags, ...parts);
  };

  // The data offset must point past this moof and mdat's header. The offset is
  // a fixed-width field, so the moof's length does not depend on its value:
  // measure once with a placeholder, then measure again with the real value.
  const measure = (dataOffset) => box("moof", mfhd, box("traf", tfhd, tfdt, trun(dataOffset)));
  const moofLength = measure(0).length;
  const moof = measure(moofLength + 8);
  const mdat = box("mdat", concat(samples));

  return concat([ftyp, moov, moof, mdat]);
}

// -----------------------------------------------------------------------------
// Encode, mux, verify
// -----------------------------------------------------------------------------

// WebCodecs is only exposed in a secure context, and `about:blank` is not one —
// so the encoder page is served from 127.0.0.1, exactly as the tests' harness is.
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<!doctype html><title>fixture</title>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(origin);

const encoded = await page.evaluate(
  async ({ width, height, frames, fps, keyframeEvery }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");

    const chunks = [];
    let description = null;
    let encoderError = null;

    const encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        if (!description && metadata?.decoderConfig?.description) {
          description = Array.from(new Uint8Array(metadata.decoderConfig.description));
        }
        chunks.push({
          timestamp: chunk.timestamp,
          duration: chunk.duration ?? 0,
          type: chunk.type,
          data: Array.from(data),
        });
      },
      error: (failure) => {
        encoderError = String(failure);
      },
    });

    // Baseline is the safest thing a phone records and the decoder certainly
    // accepts; fall back to a level this encoder reports as supported.
    let codec = "avc1.42001f";
    const wanted = { width, height, bitrate: 500_000, framerate: fps };
    for (const candidate of ["avc1.42001f", "avc1.42E01E", "avc1.640028"]) {
      const support = await VideoEncoder.isConfigSupported({ ...wanted, codec: candidate });
      if (support.supported) {
        codec = candidate;
        break;
      }
    }
    encoder.configure({ ...wanted, codec, avc: { format: "avc" } });

    for (let i = 0; i < frames; i++) {
      const t = i / fps;
      ctx.fillStyle = `hsl(${(i * 6) % 360} 70% 30%)`;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#fff";
      ctx.fillRect(((i * 4) % (width - 40)) | 0, height / 2 - 20, 40, 40);
      ctx.font = "bold 40px monospace";
      ctx.textAlign = "center";
      ctx.fillText(`t=${t.toFixed(1)}s`, width / 2, 60);

      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((i * 1e6) / fps),
        duration: Math.round(1e6 / fps),
      });
      encoder.encode(frame, { keyFrame: i % keyframeEvery === 0 });
      frame.close();
    }

    await encoder.flush();
    encoder.close();
    return { chunks, description, codec, error: encoderError };
  },
  { width: WIDTH, height: HEIGHT, frames: FRAMES, fps: FPS, keyframeEvery: KEYFRAME_EVERY }
);

if (encoded.error) throw new Error(`encoder failed: ${encoded.error}`);
if (!encoded.description) throw new Error("the encoder produced no avcC description");
if (encoded.chunks.length === 0) throw new Error("the encoder produced no chunks");

// Presentation order, and a duration per sample in the track's own timebase.
const ordered = [...encoded.chunks].sort((a, b) => a.timestamp - b.timestamp);
const timescale = FPS;
const durations = ordered.map((chunk) => {
  const duration = Math.round((chunk.duration * timescale) / 1e6);
  return duration > 0 ? duration : 1;
});

const samples = ordered.map((chunk) => Uint8Array.from(chunk.data));
const description = Uint8Array.from(encoded.description);

const classic = buildClassicMp4({
  samples,
  description,
  timescale,
  width: WIDTH,
  height: HEIGHT,
  durations,
});
const fragmented = buildFragmentedMp4({
  samples,
  description,
  timescale,
  width: WIDTH,
  height: HEIGHT,
  durations,
});

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, classic);
writeFileSync(OUT_FRAGMENTED, fragmented);

// Verify each file the way the trimmer will meet it: play it in the browser and
// ask a real decoder to decode its first samples. A muxer bug that produced a
// structurally valid but unplayable file would otherwise reach the test suite
// as a mystery.
async function verify(bytes) {
  return page.evaluate(
  async ({ bytes, description }) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: "video/mp4" });
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.src = url;

    const duration = await new Promise((resolve) => {
      video.onloadedmetadata = () => resolve(video.duration);
      video.onerror = () => resolve(NaN);
      setTimeout(() => resolve(NaN), 5000);
    });

    let decoded = 0;
    let decoderError = null;
    const decoder = new VideoDecoder({
      output: (frame) => {
        decoded++;
        frame.close();
      },
      error: (failure) => {
        decoderError = String(failure);
      },
    });
    decoder.configure({
      codec: description.codec,
      description: new Uint8Array(description.description),
      codedWidth: 320,
      codedHeight: 240,
    });
    for (let i = 0; i < Math.min(3, description.sampleCount); i++) {
      decoder.decode(
        new EncodedVideoChunk({
          type: i === 0 ? "key" : "delta",
          timestamp: Math.round((i * 1e6) / 30),
          data: new Uint8Array(description.firstSamples[i]),
        })
      );
    }
    try {
      await decoder.flush();
    } catch (error) {
      decoderError = String(error);
    }
    decoder.close();
    URL.revokeObjectURL(url);
    return { duration, width: video.videoWidth, height: video.videoHeight, decoded, decoderError };
  },
    {
      bytes: Array.from(bytes),
      description: {
        codec: encoded.codec,
        description: encoded.description,
        sampleCount: ordered.length,
        firstSamples: ordered.slice(0, 3).map((chunk) => chunk.data),
      },
    }
  );
}

for (const [label, path, bytes] of [
  ["classic", OUT, classic],
  ["fragmented", OUT_FRAGMENTED, fragmented],
]) {
  const result = await verify(bytes);
  console.log(
    `Wrote ${path} (${(bytes.length / 1024).toFixed(0)} KB) — ${SECONDS}s @ ${FPS}fps, ${encoded.codec} [${label}]`
  );
  console.log(
    `  verified: duration=${result.duration}s ${result.width}x${result.height}, ` +
      `decoded ${result.decoded} frames${result.decoderError ? ` (error: ${result.decoderError})` : ""}`
  );

  if (!Number.isFinite(result.duration) || Math.abs(result.duration - SECONDS) > 0.5) {
    throw new Error(`${label}: the muxed file does not report ${SECONDS}s (got ${result.duration})`);
  }
  if (result.decoded === 0) {
    throw new Error(`${label}: the muxed file's samples could not be decoded`);
  }
}

await browser.close();
server.close();
