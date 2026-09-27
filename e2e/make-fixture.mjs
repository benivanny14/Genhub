// =============================================================================
// GENHUB - Rebuild the browser-test video fixture
//
// Run:  node e2e/make-fixture.mjs
//
// The trimmer's browser test needs a REAL short video to cut up: a file whose
// header carries a true duration, that Chromium can actually decode, and that
// is small enough to sit in the repository. Not every tool can produce one here.
//
//   - MediaRecorder's own output is out: a WebM written by a live recorder has
//     no Duration in its header, so `video.duration` reads Infinity and the
//     trimmer (correctly) treats the file as unmeasurable.
//   - Playwright's bundled ffmpeg ships only the VP8 encoder and the WebM
//     muxer — no H.264 (which open-source Chromium could not decode anyway) and
//     no audio encoder.
//
// So the picture is drawn in Chromium, handed to ffmpeg as a JPEG stream, and
// encoded to VP8/WebM: open codecs only, so the fixture plays in the exact
// browser the tests run in, with no proprietary decoders required.
//
// The result is committed (e2e/fixtures/short.webm); this script exists so it
// can be regenerated rather than being an unexplained binary.
// =============================================================================

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "fixtures", "short.webm");

/** 6 seconds at 30fps — long enough to cut a 3s span out of the middle. */
const SECONDS = 6;
const FPS = 30;
const WIDTH = 320;
const HEIGHT = 240;
const FRAMES = SECONDS * FPS;

/** Playwright keeps its ffmpeg next to the browsers it installs. */
function findFfmpeg() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ||
    join(process.env.LOCALAPPDATA || join(process.env.HOME || "", ".cache"), "ms-playwright");
  for (const name of ["ffmpeg-win64.exe", "ffmpeg-linux", "ffmpeg-mac"]) {
    for (let revision = 1020; revision >= 1000; revision--) {
      const candidate = join(root, `ffmpeg-${revision}`, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "ffmpeg";
}

const browser = await chromium.launch();
const page = await browser.newPage();

const frames = await page.evaluate(
  async ({ width, height, frames, fps }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const out = [];
    for (let i = 0; i < frames; i++) {
      const t = i / fps;
      // A moving shape and a changing background make the frames genuinely
      // different, so the encoder has real work to do and the file is not a
      // static image a keyframe could cover for the whole clip.
      ctx.fillStyle = `hsl(${(i * 6) % 360} 70% 30%)`;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#fff";
      ctx.fillRect(((i * 4) % (width - 40)) | 0, height / 2 - 20, 40, 40);
      ctx.font = "bold 40px monospace";
      ctx.textAlign = "center";
      ctx.fillText(`t=${t.toFixed(1)}s`, width / 2, 60);
      out.push(canvas.toDataURL("image/jpeg", 0.8).split(",")[1]);
    }
    return out;
  },
  { width: WIDTH, height: HEIGHT, frames: FRAMES, fps: FPS }
);
await browser.close();

mkdirSync(dirname(OUT), { recursive: true });

const ffmpeg = findFfmpeg();
console.log(`Encoding ${FRAMES} frames with ${ffmpeg} ...`);

await new Promise((resolve, reject) => {
  const proc = spawn(ffmpeg, [
    "-y",
    "-f", "image2pipe",
    // The stream is bare concatenated JPEGs, so the codec cannot be probed —
    // it has to be named for the input to have a stream at all.
    "-c:v", "mjpeg",
    "-framerate", String(FPS),
    "-i", "pipe:0",
    "-c:v", "libvpx",
    "-b:v", "500k",
    "-pix_fmt", "yuv420p",
    "-r", String(FPS),
    "-t", String(SECONDS),
    OUT,
  ]);
  let log = "";
  proc.on("error", reject);
  proc.stderr.on("data", (chunk) => (log += chunk));
  proc.on("close", (code) =>
    code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}\n${log}`))
  );
  proc.stdin.on("error", () => {}); // ffmpeg can close the pipe first on a bad frame
  for (const frame of frames) proc.stdin.write(Buffer.from(frame, "base64"));
  proc.stdin.end();
});

const { size } = await import("node:fs").then((fs) => fs.statSync(OUT));
console.log(`Wrote ${OUT} (${(size / 1024).toFixed(0)} KB) — ${SECONDS}s @ ${FPS}fps`);
writeFileSync(join(here, "fixtures", "README.md"), [
  "# Browser-test fixtures",
  "",
  "`short.webm` is a real 6s VP8/WebM clip with a true duration in its header,",
  "used by the trimmer browser test as the video a creator would upload.",
  "Regenerate it with `node e2e/make-fixture.mjs` — see the comments in that",
  "script for why it is not produced by MediaRecorder or H.264.",
  "",
].join("\n"));
