// =============================================================================
// GENHUB - the creator trimmer, driven in a real browser
//
// What Vitest cannot prove about VideoTrimmer, and this does:
//
//   - that a real short video loads and reports its real duration;
//   - that selecting a span and pressing "Upload cut" produces a real File,
//     non-empty and DECODABLE, whose playing time matches the span that was
//     selected — the whole point of the feature;
//   - that the rest of the trimmer behaves: handles drag and clamp, the
//     playhead loops inside the span, Escape and Cancel discard, the full-video
//     escape hatch passes the original through untouched, and a browser without
//     MediaRecorder degrades instead of breaking.
//
// The fixtures are genuine 6s clips; see e2e/fixtures/README.md. `short.webm`
// is VP8/WebM (e2e/make-fixture.mjs); the two `.mp4` files are real H.264,
// classic and fragmented, for the fast-path tests (e2e/make-mp4-fixture.mjs).
// =============================================================================

import { test, expect, type Page } from "@playwright/test";
import { inspectWebm } from "./webm-inspect";

/** Must match e2e/make-fixture.mjs. */
const FIXTURE_DURATION = 6;
/** The trimmer's own floor, from src/lib/video-trim.ts. */
const MIN_TRIM_SECONDS = 1;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const startHandle = (page: Page) => page.getByRole("slider", { name: "Clip start" });
const endHandle = (page: Page) => page.getByRole("slider", { name: "Clip end" });

/** The draggable track is the parent of the handles. */
const track = (page: Page) => startHandle(page).locator("xpath=..");

const cutButton = (page: Page) => page.getByRole("button", { name: /Upload cut/ });

const SILENT_FIXTURE = "short.webm";
const AUDIO_FIXTURE = "short-with-audio.webm";
/** A phone-shaped H.264 clip: classic MP4, sample tables filled in. */
const H264_FIXTURE = "short-h264.mp4";
/** The same clip as a browser's MediaRecorder writes it: fragmented MP4. */
const FRAGMENTED_FIXTURE = "short-h264-fragmented.mp4";

async function openTrimmer(
  page: Page,
  fixture = SILENT_FIXTURE,
  options: { minDurationSeconds?: number } = {}
) {
  const query = new URLSearchParams({ fixture });
  if (options.minDurationSeconds) {
    query.set("min", String(options.minDurationSeconds));
  }
  await page.goto(`/e2e/harness/index.html?${query.toString()}`);
  await expect
    .poll(() => page.evaluate(() => window.__harness?.fixture?.name ?? null))
    .toBe(fixture);
  // The button only reads "Drag to cut" once the duration is known and the
  // browser is able to re-encode, so this waits for the component to be ready.
  await expect(page.getByRole("button", { name: "Drag to cut" })).toBeVisible();
}

/** The component's own view of the source length, straight from the <video>. */
async function sourceDuration(page: Page): Promise<number> {
  return page.evaluate(() => {
    const video = document.querySelector("video");
    return video ? video.duration : NaN;
  });
}

async function previewTime(page: Page): Promise<number> {
  return page.evaluate(() => {
    const video = document.querySelector("video");
    return video ? video.currentTime : NaN;
  });
}

async function range(page: Page) {
  return {
    start: Number(await startHandle(page).getAttribute("aria-valuenow")),
    end: Number(await endHandle(page).getAttribute("aria-valuenow")),
  };
}

/** Move a handle with the keyboard — the accessible equivalent of a drag. */
async function nudge(
  page: Page,
  which: "Clip start" | "Clip end",
  key: "ArrowLeft" | "ArrowRight",
  times = 1
) {
  const handle = which === "Clip start" ? startHandle(page) : endHandle(page);
  for (let i = 0; i < times; i++) await handle.press(key);
}

/** Drag a handle so it lands at `ratio` of the track's width. */
async function dragHandle(page: Page, which: "Clip start" | "Clip end", ratio: number) {
  const box = await track(page).boundingBox();
  const handle = which === "Clip start" ? startHandle(page) : endHandle(page);
  const handleBox = await handle.boundingBox();
  if (!box || !handleBox) throw new Error("track or handle has no layout");

  const y = handleBox.y + handleBox.height / 2;
  await page.mouse.move(handleBox.x + handleBox.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * ratio, y, { steps: 15 });
  await page.mouse.up();
}

/**
 * Drag a handle with a real touch pointer, the way a thumb would.
 *
 * `page.mouse` sends a mouse pointer, which would prove nothing about the phone
 * this audience actually uses. Chromium's Input domain sends genuine touch
 * events, and those reach the component as pointer events of pointerType
 * "touch" — the same path a finger takes, capture and all.
 */
async function touchDrag(page: Page, which: "Clip start" | "Clip end", ratio: number) {
  const box = await track(page).boundingBox();
  const handle = which === "Clip start" ? startHandle(page) : endHandle(page);
  const handleBox = await handle.boundingBox();
  if (!box || !handleBox) throw new Error("track or handle has no layout");

  const client = await page.context().newCDPSession(page);
  const y = handleBox.y + handleBox.height / 2;
  const fromX = handleBox.x + handleBox.width / 2;
  const toX = box.x + box.width * ratio;
  const point = (x: number) => [
    { x, y, radiusX: 6, radiusY: 6, force: 1, id: 0 },
  ];

  try {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: point(fromX),
    });
    const steps = 15;
    for (let i = 1; i <= steps; i++) {
      const x = fromX + ((toX - fromX) * i) / steps;
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: point(x),
      });
    }
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await client.detach().catch(() => {});
  }
}

async function clickTrack(page: Page, ratio: number) {
  const box = await track(page).boundingBox();
  if (!box) throw new Error("track has no layout");
  await page.mouse.click(box.x + box.width * ratio, box.y + box.height / 2);
}

async function confirmations(page: Page) {
  return page.evaluate(() =>
    window.__harness.confirmations.map(({ name, type, size, trimmed, path }) => ({
      name,
      type,
      size,
      trimmed,
      path,
    }))
  );
}

async function confirmationCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__harness.confirmations.length);
}

interface Measured {
  duration: number;
  width: number;
  height: number;
  error?: string;
}

/**
 * Decode a produced File in the page and report what it actually is.
 *
 * A MediaRecorder-written WebM carries no Duration element in its header, so
 * `video.duration` reads Infinity until something forces the demuxer to walk
 * the clusters. Seeking far past the end is the standard way to force it, and
 * doing it here — rather than trusting the component's own progress counter —
 * is what makes the duration assertion independent of the code under test.
 */
async function measure(page: Page, index = 0): Promise<Measured> {
  return page.evaluate(async (which) => {
    const entry = window.__harness.confirmations[which];
    if (!entry) return { duration: NaN, width: 0, height: 0, error: "no confirmation" };

    const url = URL.createObjectURL(entry.file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.src = url;

    const measured = await new Promise<Measured>((resolve) => {
      const done = (duration: number) =>
        resolve({
          duration,
          width: video.videoWidth,
          height: video.videoHeight,
        });

      video.onloadedmetadata = () => {
        if (Number.isFinite(video.duration)) {
          done(video.duration);
          return;
        }
        video.ondurationchange = () => {
          if (Number.isFinite(video.duration)) done(video.duration);
        };
        video.currentTime = 1e101;
        setTimeout(() => done(video.duration), 5000);
      };
      video.onerror = () => resolve({ duration: NaN, width: 0, height: 0, error: "decode failed" });
      setTimeout(() => resolve({ duration: NaN, width: 0, height: 0, error: "timeout" }), 8000);
    });

    URL.revokeObjectURL(url);
    return measured;
  }, index);
}

/**
 * The bytes of a produced File, in the test process.
 *
 * A File cannot cross the boundary, so it travels as base64 — a few tens of
 * KB for these clips — and is parsed as a container on this side.
 */
async function producedBytes(page: Page, index = 0): Promise<Buffer> {
  const base64 = await page.evaluate(async (which) => {
    const entry = window.__harness.confirmations[which];
    if (!entry) return "";
    const bytes = new Uint8Array(await entry.file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }, index);
  return Buffer.from(base64, "base64");
}

interface AudioProbe {
  hasAudio: boolean;
  /** Playing time of the decoded soundtrack. */
  duration: number;
  /** Root-mean-square of the samples: > 0 means sound, not silence. */
  rms: number;
  error?: string;
}

/**
 * Ask a produced File whether it has a soundtrack, by trying to decode one.
 *
 * `decodeAudioData` rejects outright for a container with no audio track, which
 * makes it a real answer to "did the audio survive the cut?" — and one that the
 * silent fixture is used to prove is not simply always true.
 */
async function probeAudio(page: Page, index = 0): Promise<AudioProbe> {
  return page.evaluate(async (which) => {
    const entry = window.__harness.confirmations[which];
    if (!entry) return { hasAudio: false, duration: NaN, rms: 0, error: "no confirmation" };

    const bytes = await entry.file.arrayBuffer();
    const context = new AudioContext();
    try {
      // `slice(0)` because decoding detaches the buffer.
      const buffer = await context.decodeAudioData(bytes.slice(0));
      const channel = buffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
      return {
        hasAudio: true,
        duration: buffer.duration,
        rms: Math.sqrt(sum / Math.max(1, channel.length)),
      };
    } catch (error) {
      return {
        hasAudio: false,
        duration: NaN,
        rms: 0,
        error: error instanceof Error ? error.name : String(error),
      };
    } finally {
      void context.close();
    }
  }, index);
}

/** Select [2s, 5s] on the 6s fixture: three seconds kept, deterministically. */
async function selectThreeSeconds(page: Page) {
  await nudge(page, "Clip start", "ArrowRight", 2);
  await nudge(page, "Clip end", "ArrowLeft", 1);
  await expect(page.getByText(/Keeping 0:03 of 0:06/)).toBeVisible();
}

// -----------------------------------------------------------------------------
// Loading
// -----------------------------------------------------------------------------

test.describe("loading a real video", () => {
  test("reads the source duration, not Infinity", async ({ page }) => {
    await openTrimmer(page);

    await expect.poll(() => sourceDuration(page)).toBeCloseTo(FIXTURE_DURATION, 1);
    // The whole feature depends on this: a file whose length is unmeasurable
    // leaves every control disabled.
    expect(Number.isFinite(await sourceDuration(page))).toBe(true);

    await expect(page.getByText("Keeping 0:06 of 0:06")).toBeVisible();
    await expect(page.getByText("0:06").first()).toBeVisible();
  });

  test("starts on the full range, so nothing is cut by accident", async ({ page }) => {
    await openTrimmer(page);

    expect(await range(page)).toEqual({ start: 0, end: FIXTURE_DURATION });
    await expect(page.getByRole("button", { name: "Drag to cut" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Upload full video" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Reset to full video" })).toHaveCount(0);
  });

  test("exposes each handle position to assistive tech", async ({ page }) => {
    await openTrimmer(page);

    await expect(startHandle(page)).toHaveAttribute("aria-valuemin", "0");
    await expect(startHandle(page)).toHaveAttribute("aria-valuemax", String(FIXTURE_DURATION));
    await expect(startHandle(page)).toHaveAttribute("aria-valuenow", "0");
    await expect(endHandle(page)).toHaveAttribute("aria-valuenow", String(FIXTURE_DURATION));

    await nudge(page, "Clip start", "ArrowRight", 2);
    await expect(startHandle(page)).toHaveAttribute("aria-valuenow", "2");
  });
});

// -----------------------------------------------------------------------------
// The cut itself
// -----------------------------------------------------------------------------

test.describe("the cut", () => {
  test("produces a non-empty decodable File whose duration matches the selected range", async ({
    page,
  }) => {
    await openTrimmer(page);
    await selectThreeSeconds(page);

    const button = cutButton(page);
    await expect(button).toBeEnabled();
    await button.click();

    // The creator watches it work rather than staring at a frozen dialog.
    await expect(page.getByText(/Cutting and previewing/)).toBeVisible();

    await expect.poll(() => confirmationCount(page), { timeout: 60_000 }).toBe(1);

    const [result] = await confirmations(page);
    expect(result.trimmed).toBe(true);
    expect(result.name).toBe("short-trimmed.webm");
    expect(result.type).toBe("video/webm");
    // Non-empty, and big enough to be a real clip rather than a container stub.
    expect(result.size).toBeGreaterThan(20_000);

    const produced = await measure(page);
    expect(produced.error).toBeUndefined();
    // Decodable: the canvas was actually drawn into, not left blank.
    expect(produced.width).toBeGreaterThan(0);
    expect(produced.height).toBeGreaterThan(0);

    // The assertion the feature exists for: three seconds selected, three
    // seconds produced. WebCodecs holds the file to the frames it actually
    // found, so the tail can only run one frame over — not the hundreds of
    // milliseconds a real-time recorder overshoots by.
    expect(produced.duration).toBeGreaterThan(3 - 0.15);
    expect(produced.duration).toBeLessThan(3 + 0.15);

    // Frame accuracy, read out of the container: the fixture runs at 30fps, so
    // three seconds is about ninety frames, evenly spaced and starting at zero.
    const container = inspectWebm(new Uint8Array(await producedBytes(page)));
    expect(container.tracks).toEqual([1]);
    expect(container.durationMs).toBeGreaterThanOrEqual(2960);
    expect(container.durationMs).toBeLessThanOrEqual(3040);

    const frames = container.frames.filter((frame) => frame.track === 1);
    expect(frames.length).toBeGreaterThanOrEqual(88);
    expect(frames.length).toBeLessThanOrEqual(93);
    expect(frames[0].timeMs).toBe(0);
    // The first frame is a keyframe — a clip that opens on a delta frame cannot
    // be decoded from its start, which is exactly where a player begins.
    expect(frames[0].keyframe).toBe(true);
    for (let i = 1; i < frames.length; i++) {
      const gap = frames[i].timeMs - frames[i - 1].timeMs;
      expect(gap).toBeGreaterThanOrEqual(30);
      expect(gap).toBeLessThanOrEqual(40);
    }

    // This source has no soundtrack, and the cut must not invent one. That also
    // pins down the audio test below: it is not a check that always passes.
    expect((await probeAudio(page)).hasAudio).toBe(false);

    await expect(page.getByTestId("closed")).toBeVisible();
  });

  test("cutting a short span still produces a playable file", async ({ page }) => {
    await openTrimmer(page);
    // The floor the component enforces: exactly one second.
    await nudge(page, "Clip end", "ArrowLeft", 5);
    await expect(page.getByText(/Keeping 0:01/)).toBeVisible();

    await cutButton(page).click();
    await expect.poll(() => confirmationCount(page), { timeout: 60_000 }).toBe(1);

    const produced = await measure(page);
    expect(produced.error).toBeUndefined();
    expect(produced.duration).toBeGreaterThan(MIN_TRIM_SECONDS - 0.5);
    expect(produced.duration).toBeLessThan(MIN_TRIM_SECONDS + 1);
  });
});

// -----------------------------------------------------------------------------
// Seeing where the cut lands
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// A clip the way a phone records one
// -----------------------------------------------------------------------------

/**
 * The fast path used to help WebM/VP8 sources only, because only WebM was read
 * back. A phone records H.264 in an MP4, and this is the test that the same path
 * now reads that container.
 *
 * The `path` assertion is the one that matters. "It produced a correct cut" is
 * NOT evidence of the fast path: the frame-walk and the recorder both produce
 * correct cuts too, just slowly. Only `decoder` proves the demuxer's samples
 * actually reached VideoDecoder — and a demuxer that returned nothing would
 * quietly fall through to `seek` and still pass a duration check.
 */
test.describe("an H.264 clip from a phone", () => {
  test("takes the decoder fast path, and cuts exactly the frames chosen", async ({ page }) => {
    await openTrimmer(page, H264_FIXTURE);
    await selectThreeSeconds(page);

    await cutButton(page).click();
    await expect.poll(() => confirmationCount(page), { timeout: 60_000 }).toBe(1);

    const [result] = await confirmations(page);
    expect(result.trimmed).toBe(true);
    expect(result.type).toBe("video/webm");
    expect(result.size).toBeGreaterThan(20_000);
    expect(result.path).toBe("decoder");

    const produced = await measure(page);
    expect(produced.error).toBeUndefined();
    expect(produced.width).toBeGreaterThan(0);
    expect(produced.height).toBeGreaterThan(0);
    // Three seconds selected, three seconds produced, frame-exact.
    expect(produced.duration).toBeGreaterThan(3 - 0.15);
    expect(produced.duration).toBeLessThan(3 + 0.15);

    const container = inspectWebm(new Uint8Array(await producedBytes(page)));
    const frames = container.frames.filter((frame) => frame.track === 1);
    expect(frames.length).toBeGreaterThanOrEqual(88);
    expect(frames.length).toBeLessThanOrEqual(93);
    expect(frames[0].timeMs).toBe(0);
    expect(frames[0].keyframe).toBe(true);

    // No soundtrack in the source, so none invented in the cut.
    expect((await probeAudio(page)).hasAudio).toBe(false);
  });

  test("a fragmented MP4, as a browser records it, takes the fast path too", async ({ page }) => {
    await openTrimmer(page, FRAGMENTED_FIXTURE);
    await selectThreeSeconds(page);

    await cutButton(page).click();
    await expect.poll(() => confirmationCount(page), { timeout: 60_000 }).toBe(1);

    const [result] = await confirmations(page);
    expect(result.path).toBe("decoder");

    const produced = await measure(page);
    expect(produced.error).toBeUndefined();
    expect(produced.duration).toBeGreaterThan(3 - 0.15);
    expect(produced.duration).toBeLessThan(3 + 0.15);
  });
});

test.describe("the timeline preview", () => {
  test("draws frames from across the clip", async ({ page }) => {
    await openTrimmer(page);

    const strip = page.getByTestId("frame-strip");
    await expect(strip).toBeVisible();
    await expect(strip.locator("img")).toHaveCount(8, { timeout: 20_000 });

    // Real pictures, not placeholders: every one is a captured frame.
    const sources = await strip.locator("img").evaluateAll((images) =>
      images.map((image) => (image as HTMLImageElement).src)
    );
    expect(sources).toHaveLength(8);
    for (const source of sources) expect(source.startsWith("data:image/jpeg")).toBe(true);
  });

  test("does not get in the way of dragging a handle", async ({ page }) => {
    await openTrimmer(page);
    await expect(page.getByTestId("frame-strip").locator("img").first()).toBeVisible({
      timeout: 20_000,
    });

    // The strip covers the whole track, so if it took pointer events the handles
    // would stop working the moment the frames appeared.
    await dragHandle(page, "Clip start", 0.4);
    expect((await range(page)).start).toBeGreaterThan(1.5);
  });
});

// -----------------------------------------------------------------------------
// The length a paid scene has to reach
// -----------------------------------------------------------------------------

test.describe("the publishing length rule", () => {
  test("is stated before the handles are touched", async ({ page }) => {
    await openTrimmer(page, SILENT_FIXTURE, { minDurationSeconds: 10 });

    // Nothing has been dragged yet, and the rule is already on screen — which is
    // the whole point: a creator can cut a 20-second scene, wait for the upload,
    // and only then find out it can never go live.
    await expect(page.getByTestId("minimum-rule")).toBeVisible();
    await expect(page.getByTestId("minimum-rule")).toContainText("0:10");
  });

  test("warns while the cut is too short, and says so when it is long enough", async ({
    page,
  }) => {
    await openTrimmer(page, SILENT_FIXTURE, { minDurationSeconds: 4 });

    const status = page.getByTestId("length-status");

    // The untouched 6-second clip is already long enough…
    await expect(status).toContainText("long enough for a paid scene");

    // …and the moment the cut drops under the rule, it says how far under.
    await nudge(page, "Clip end", "ArrowLeft", 3);
    await expect(page.getByText(/Keeping 0:03 of 0:06/)).toBeVisible();
    await expect(status).toContainText("0:03");
    await expect(status).toContainText("never go live");

    // The cut is still offered — the rule is advice, not a lock.
    await expect(cutButton(page)).toBeEnabled();
  });

  test("says nothing about a rule when there is none", async ({ page }) => {
    await openTrimmer(page);

    await expect(page.getByTestId("minimum-rule")).toHaveCount(0);
    await expect(page.getByTestId("length-status")).toHaveCount(0);
  });
});

// -----------------------------------------------------------------------------
// The creator's own audio
// -----------------------------------------------------------------------------

test.describe("a video that has sound", () => {
  test("keeps the audio through the cut, and only across the kept span", async ({ page }) => {
    await openTrimmer(page, AUDIO_FIXTURE);

    const source = await sourceDuration(page);
    expect(Number.isFinite(source)).toBe(true);
    expect(source).toBeGreaterThan(3.5);

    // Keep everything but the last two seconds.
    await nudge(page, "Clip end", "ArrowLeft", 2);
    const kept = (await range(page)).end - (await range(page)).start;
    expect(kept).toBeGreaterThan(1.5);
    expect(kept).toBeLessThan(2.5);

    await cutButton(page).click();
    await expect.poll(() => confirmationCount(page), { timeout: 60_000 }).toBe(1);

    const [result] = await confirmations(page);
    expect(result.size).toBeGreaterThan(10_000);

    // The picture is still a picture…
    const produced = await measure(page);
    expect(produced.error).toBeUndefined();
    expect(produced.width).toBeGreaterThan(0);
    expect(produced.duration).toBeGreaterThan(kept - 0.6);
    expect(produced.duration).toBeLessThan(kept + 1);

    // …and so is the sound. A cut that silently dropped the audio would decode
    // to nothing here, and one that lost the tone would read as silence.
    const audio = await probeAudio(page);
    expect(audio.error).toBeUndefined();
    expect(audio.hasAudio).toBe(true);
    expect(audio.rms).toBeGreaterThan(0.05);
    expect(audio.duration).toBeGreaterThan(kept - 0.6);
    expect(audio.duration).toBeLessThan(kept + 1);

    // Both tracks are in the one file, at the one length.
    const container = inspectWebm(new Uint8Array(await producedBytes(page)));
    expect(container.tracks.sort()).toEqual([1, 2]);
  });

});

// -----------------------------------------------------------------------------
// The path that works everywhere
// -----------------------------------------------------------------------------

test.describe("a browser without WebCodecs", () => {
  test("still walks the frames when the file cannot be demuxed", async ({ page }) => {
    // The demuxer + VideoDecoder is the fast path. Without a decoder the export
    // has to fall back to seeking the element, which must still be frame-exact.
    await page.addInitScript(() => {
      Object.defineProperty(window, "VideoDecoder", {
        configurable: true,
        get: () => undefined,
      });
    });

    await openTrimmer(page);
    await selectThreeSeconds(page);
    await cutButton(page).click();
    await expect.poll(() => confirmationCount(page), { timeout: 60_000 }).toBe(1);

    const produced = await measure(page);
    expect(produced.error).toBeUndefined();
    expect(produced.duration).toBeGreaterThan(3 - 0.15);
    expect(produced.duration).toBeLessThan(3 + 0.15);

    const container = inspectWebm(new Uint8Array(await producedBytes(page)));
    const frames = container.frames.filter((frame) => frame.track === 1);
    expect(frames.length).toBeGreaterThanOrEqual(88);
    expect(frames.length).toBeLessThanOrEqual(93);
  });

  test("still cuts, through the recorder", async ({ page }) => {
    // The fast path is an optimisation, not a requirement: a browser without it
    // must still produce a usable cut through the recorder, or the feature is
    // silently lost on exactly the older handsets this audience uses.
    await page.addInitScript(() => {
      Object.defineProperty(window, "VideoEncoder", {
        configurable: true,
        get: () => undefined,
      });
    });

    await openTrimmer(page);
    await selectThreeSeconds(page);
    await cutButton(page).click();
    await expect.poll(() => confirmationCount(page), { timeout: 60_000 }).toBe(1);

    const [result] = await confirmations(page);
    expect(result.name).toBe("short-trimmed.webm");
    expect(result.size).toBeGreaterThan(20_000);

    // Recorded in real time, so the tail is allowed to run further over — the
    // looser bound is what makes this a fallback path rather than a second
    // implementation of the same thing.
    const produced = await measure(page);
    expect(produced.error).toBeUndefined();
    expect(produced.duration).toBeGreaterThan(3 - 0.5);
    expect(produced.duration).toBeLessThan(3 + 1);
    expect(produced.width).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------
// Selecting the range
// -----------------------------------------------------------------------------

test.describe("selecting the range", () => {
  test("dragging a handle moves it, and the end can never cross the start", async ({ page }) => {
    await openTrimmer(page);

    // Grabs the handle in its very middle, which is the grip the creator sees —
    // and is a child element, not the handle itself.
    await dragHandle(page, "Clip start", 0.4);
    const dragged = await range(page);
    expect(dragged.start).toBeGreaterThan(1.5);
    expect(dragged.start).toBeLessThan(3.5);

    // Dragged to the very left of the track, long past the start handle: the
    // inline clamp must stop it one second after the start, never before it.
    await dragHandle(page, "Clip end", 0.02);
    await expect(page.getByText(/Keeping 0:01 of/)).toBeVisible();
    const clamped = await range(page);
    expect(clamped.end).toBeGreaterThan(clamped.start);
    await expect(page.getByRole("button", { name: /Upload cut \(0:01\)/ })).toBeEnabled();
  });

  test("the keyboard nudges a handle by a second", async ({ page }) => {
    await openTrimmer(page);

    await nudge(page, "Clip start", "ArrowRight", 3);
    await expect(startHandle(page)).toHaveAttribute("aria-valuenow", "3");
    await expect(page.getByText(/Keeping 0:03 of 0:06/)).toBeVisible();

    await nudge(page, "Clip end", "ArrowLeft", 2);
    await expect(endHandle(page)).toHaveAttribute("aria-valuenow", "4");
    await expect(page.getByText(/Keeping 0:01 of 0:06/)).toBeVisible();
  });

  test("clicking the track seeks the preview", async ({ page }) => {
    await openTrimmer(page);

    await clickTrack(page, 0.5);
    await expect.poll(() => previewTime(page)).toBeGreaterThan(2.6);
    await expect.poll(() => previewTime(page)).toBeLessThan(3.4);
  });

  test("reset returns the range to the whole video", async ({ page }) => {
    await openTrimmer(page);
    await selectThreeSeconds(page);

    const reset = page.getByRole("button", { name: "Reset to full video" });
    await expect(reset).toBeVisible();
    await reset.click();

    await expect(page.getByText("Keeping 0:06 of 0:06")).toBeVisible();
    await expect(reset).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Drag to cut" })).toBeDisabled();
  });
});

// -----------------------------------------------------------------------------
// Reading my selection before I commit to it
// -----------------------------------------------------------------------------

test.describe("watching it before uploading", () => {
  test("the preview loops inside the kept span and never plays the cut part", async ({ page }) => {
    await openTrimmer(page);
    await selectThreeSeconds(page);

    // Park the playhead outside the span, at the very start of the video.
    await clickTrack(page, 0.02);
    await expect.poll(() => previewTime(page)).toBeLessThan(0.5);

    await page.getByRole("button", { name: "Play preview" }).click();
    // Play from outside the span must land on the kept start, not preview the
    // seconds that are about to be thrown away.
    await page.waitForTimeout(350);
    const afterPlay = await previewTime(page);
    expect(afterPlay).toBeGreaterThan(1.6);
    expect(afterPlay).toBeLessThan(2.9);

    // Sample for longer than the span; the playhead has to wrap rather than
    // run on into the discarded tail.
    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      samples.push(await previewTime(page));
      await page.waitForTimeout(120);
    }

    expect(Math.max(...samples)).toBeLessThan(5.8);
    expect(Math.min(...samples)).toBeGreaterThan(1.6);
    const wrapped = samples.some((value, index) => index > 0 && value < samples[index - 1] - 1);
    expect(wrapped).toBe(true);

    await page.getByRole("button", { name: "Pause preview" }).click();
  });
});

// -----------------------------------------------------------------------------
// Backing out
// -----------------------------------------------------------------------------

test.describe("getting out", () => {
  test("Escape closes the trimmer without exporting anything", async ({ page }) => {
    await openTrimmer(page);
    await selectThreeSeconds(page);

    await page.keyboard.press("Escape");

    await expect(page.getByTestId("closed")).toBeVisible();
    expect(await confirmationCount(page)).toBe(0);
    expect(await page.evaluate(() => window.__harness.cancels)).toBe(1);
  });

  test("the close button closes it too", async ({ page }) => {
    await openTrimmer(page);

    await page.getByRole("button", { name: "Close" }).click();

    await expect(page.getByTestId("closed")).toBeVisible();
    expect(await page.evaluate(() => window.__harness.cancels)).toBe(1);
  });

  test("cancelling a cut throws it away and leaves the range alone", async ({ page }) => {
    await openTrimmer(page);
    // Five seconds kept, so there is time to cancel mid-encode.
    await nudge(page, "Clip start", "ArrowRight", 1);
    await expect(page.getByText(/Keeping 0:05 of 0:06/)).toBeVisible();

    await cutButton(page).click();
    await expect(page.getByRole("button", { name: "Cancel cut" })).toBeVisible();

    await expect(page.getByText(/Cutting and previewing/)).toBeVisible();
    await page.getByRole("button", { name: "Cancel cut" }).click();

    await expect(cutButton(page)).toBeVisible();
    await expect(page.getByText(/Something went wrong while cutting/)).toHaveCount(0);
    // Give it a beat: a cut that was not really cancelled would land here.
    await page.waitForTimeout(1500);
    expect(await confirmationCount(page)).toBe(0);
    expect(await range(page)).toEqual({ start: 1, end: FIXTURE_DURATION });
  });

  test("Escape does nothing mid-cut, so a half-written file is never left behind", async ({
    page,
  }) => {
    await openTrimmer(page);
    await nudge(page, "Clip start", "ArrowRight", 1);

    await cutButton(page).click();
    await expect(page.getByText(/Cutting and previewing/)).toBeVisible();
    await page.keyboard.press("Escape");

    // Still cutting: the dialog was not closed out from under the recorder.
    await expect(page.getByText(/Cutting and previewing/)).toBeVisible();
    expect(await page.evaluate(() => window.__harness.cancels)).toBe(0);

    await page.getByRole("button", { name: "Cancel cut" }).click();
    await expect(cutButton(page)).toBeVisible();
  });

  test("uploading the full video passes the original file through untouched", async ({ page }) => {
    await openTrimmer(page);
    const fixtureSize = await page.evaluate(() => window.__harness.fixture?.size ?? 0);

    await page.getByRole("button", { name: "Upload full video" }).click();
    await expect.poll(() => confirmationCount(page)).toBe(1);

    const [result] = await confirmations(page);
    expect(result.trimmed).toBe(false);
    expect(result.name).toBe("short.webm");
    expect(result.size).toBe(fixtureSize);
  });
});

// -----------------------------------------------------------------------------
// Degrading
// -----------------------------------------------------------------------------

test.describe("a browser that cannot cut", () => {
  test("says so and offers the whole file instead of failing", async ({ page }) => {
    // Feature-detect before any page script runs, the way a browser without
    // MediaRecorder would look to the component.
    await page.addInitScript(() => {
      Object.defineProperty(window, "MediaRecorder", {
        configurable: true,
        get: () => undefined,
      });
    });

    await openTrimmer(page);
    await expect(page.getByText(/This browser cannot cut video/)).toBeVisible();

    await nudge(page, "Clip start", "ArrowRight", 2);
    await expect(page.getByText(/Keeping 0:04 of 0:06/)).toBeVisible();

    // The cut is offered but unusable; the original is still uploadable.
    await expect(cutButton(page)).toBeDisabled();
    await expect(page.getByRole("button", { name: "Upload full video" })).toBeEnabled();
  });
});

// -----------------------------------------------------------------------------
// A phone, held in one hand
// -----------------------------------------------------------------------------
//
// This is the device the trimmer is really for: a creator on a handset, cutting
// a clip with a thumb, on a viewport that fits no desktop layout. The desktop
// tests would pass with handles too small to hit and with a track that swallowed
// the drag; these do not.

test.describe("a phone-sized viewport with touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the handles are big enough for a thumb", async ({ page }) => {
    await openTrimmer(page);

    // At this width the CSS grows the grip to 44px tall / 28px wide, plus a
    // hit area that reaches beyond the drawn edge. A thumb needs that: the
    // desktop grip is 20px by 36px, which is a miss more often than a hit.
    for (const handle of [startHandle(page), endHandle(page)]) {
      const box = await handle.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(40);
      expect(box!.width).toBeGreaterThanOrEqual(24);
    }
  });

  test("a thumb drags a handle, and the cut still lands on the frames", async ({ page }) => {
    await openTrimmer(page);

    await touchDrag(page, "Clip start", 0.35);
    const dragged = await range(page);
    // A touch drag moved the range — not scrolled the dialog, not been
    // swallowed by the frame strip behind the handles.
    expect(dragged.start).toBeGreaterThan(1.2);
    expect(dragged.start).toBeLessThan(3.2);

    const kept = dragged.end - dragged.start;
    expect(kept).toBeGreaterThan(1);

    await cutButton(page).click();
    await expect.poll(() => confirmationCount(page), { timeout: 60_000 }).toBe(1);

    const [result] = await confirmations(page);
    expect(result.trimmed).toBe(true);
    expect(result.name).toBe("short-trimmed.webm");
    expect(result.size).toBeGreaterThan(20_000);

    // The thumb chose a span; the file is that span, decodable and the right
    // length — on a phone-sized viewport, driven by touch.
    const produced = await measure(page);
    expect(produced.error).toBeUndefined();
    expect(produced.width).toBeGreaterThan(0);
    expect(produced.duration).toBeGreaterThan(kept - 0.25);
    expect(produced.duration).toBeLessThan(kept + 0.25);

    const container = inspectWebm(new Uint8Array(await producedBytes(page)));
    const frames = container.frames.filter((frame) => frame.track === 1);
    expect(frames.length).toBeGreaterThanOrEqual(Math.floor(kept * 30) - 3);
    expect(frames.length).toBeLessThanOrEqual(Math.ceil(kept * 30) + 3);
  });

  test("a thumb can pull the end handle in too", async ({ page }) => {
    await openTrimmer(page);

    await touchDrag(page, "Clip end", 0.5);
    const dragged = await range(page);
    expect(dragged.end).toBeGreaterThan(2.4);
    expect(dragged.end).toBeLessThan(3.6);
    expect(await dragged.end).toBeGreaterThan(dragged.start);

    await expect(page.getByRole("button", { name: /Upload cut \(0:03\)/ })).toBeEnabled();
  });
});
