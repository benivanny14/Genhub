// =============================================================================
// GENHUB - Cutting a video without playing it
// =============================================================================
//
// lib/video-trim.ts's MediaRecorder path (in components/VideoTrimmer.tsx) has
// two costs that show up on exactly the device this product is built for:
//
//   1. It runs in REAL TIME. Keep thirty seconds and the creator waits thirty
//      seconds, phone in hand, watching a progress bar that cannot be hurried.
//   2. Its boundaries are wherever the recorder happened to start and stop. A
//      cut nominally of 3.00s can come out 3.2s, opening on a frame the creator
//      chose to drop.
//
// WebCodecs fixes both. Frames are taken from the source element by seeking, and
// each one is encoded with the exact presentation timestamp the browser reports
// for it — 90 frames at 0, 33, 67, 100ms for a three-second cut, rather than
// whatever the compositor happened to hand over. The audio is decoded, sliced and
// re-encoded exactly.
//
// ON SPEED, HONESTLY. This is not instant, and it is worth saying why: a frame
// can only be obtained by seeking to it, and a seek that presents a frame costs
// about one frame interval (measured in Chromium: ~21ms to seek, ~48ms to seek
// and be told which frame arrived). So the walk runs at roughly real time — a
// wash against recording the span — and what the creator gains is a cut that is
//      frame-exact and never drops or duplicates a frame on a busy machine. Making it
// genuinely instant means demuxing the source and feeding VideoDecoder its own
// chunks instead of seeking — which src/lib/webm.ts and src/lib/mp4.ts do, for
// the two containers a creator's file actually arrives in.
//
// What WebCodecs does NOT provide is a container: VideoEncoder and AudioEncoder
// hand back encoded chunks, and a demuxer/muxer is required to make a file.
// src/lib/webm.ts is that muxer, written here rather than added as a dependency.
//
// There are two ways to get the frames, in order of preference:
//
//   1. Demux the file and hand the encoded chunks to VideoDecoder. No seeking,
//      no waiting for a frame to be presented — decode is CPU-bound, so a
//      three-second cut finishes in a fraction of a second. WebM (VP8/VP9) and
//      MP4 (H.264/AV1/VP9) are both read, so a phone's H.264 clip takes this
//      path too rather than the recorder's.
//   2. Seek the <video> element frame by frame, waiting for each presentation.
//      Slower (about real time), but it works on any file the browser can play,
//      including one the demuxers do not understand.
//
// Both are best-effort by design. They are optional paths, not mandatory ones: a
// browser without the APIs, an encoder that refuses a codec, a source that will
// not seek — all of them throw, and the caller falls back to the MediaRecorder
// path that works everywhere.
// =============================================================================

import {
  AUDIO_TRACK,
  VIDEO_TRACK,
  buildWebm,
  demuxWebm,
  type WebmAudioTrack,
  type WebmFrame,
} from "./webm";
import { demuxMp4 } from "./mp4";
import { exportCanvasSize, recordingBitsPerSecond } from "./video-trim";

/** Opus always runs at 48kHz, so the audio is resampled to that before encoding. */
const OPUS_SAMPLE_RATE = 48_000;
/** One Opus packet is 20ms; the encoder wants whole packets. */
const OPUS_FRAME_SAMPLES = 960;
/** A video keyframe every two seconds keeps seeking and the file honest. */
const KEYFRAME_INTERVAL_S = 2;
/** Above this, decoding the source's audio into memory stops being reasonable. */
const MAX_AUDIO_DECODE_BYTES = 512 * 1024 * 1024;

export interface WebCodecsExportOptions {
  /** The source element, loaded with the file being cut. */
  element: HTMLVideoElement;
  /** The original File — its name, and the bytes the audio is decoded from. */
  file: File;
  /** Seconds into the source to begin at. */
  start: number;
  /** Seconds into the source to stop at. */
  end: number;
  onProgress?: (percent: number) => void;
  isCancelled?: () => boolean;
}

export interface WebCodecsExportResult {
  /**
   * The encoded bytes, ready to be wrapped in a File.
   *
   * Typed against `ArrayBuffer` rather than the default `ArrayBufferLike` so it
   * can be handed to a `File` without a cast: the writer builds its output in
   * one freshly allocated array, so the backing buffer is always exactly it.
   */
  data: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  /** True when a soundtrack was encoded alongside the picture. */
  hasAudio: boolean;
  /**
   * Where the frames came from: the file's own encoded chunks (`decoder`), or
   * seeking the element frame by frame (`seek`). Reported rather than guessed at
   * because the difference is the whole point of preferring the first one.
   */
  frameSource: "decoder" | "seek";
}

/**
 * Whether this browser can take the fast path at all.
 *
 * `requestVideoFrameCallback` is not optional: it is how a seek reports the
 * exact presentation time of the frame it landed on, and without it the cut
 * could only guess at its own boundaries — which is the thing this path exists
 * to fix. Every other member is a plain capability check.
 */
export function webCodecsExportSupported(): boolean {
  if (typeof window === "undefined") return false;
  return (
    typeof window.VideoEncoder === "function" &&
    typeof window.VideoFrame === "function" &&
    typeof HTMLVideoElement.prototype.requestVideoFrameCallback === "function"
  );
}

/** Whether a soundtrack can be re-encoded too (the video path works regardless). */
function audioSupported(): boolean {
  return (
    typeof window.AudioEncoder === "function" &&
    typeof window.AudioContext === "function" &&
    typeof window.OfflineAudioContext === "function"
  );
}

/**
 * Arm the frame callback, resolving with the presentation time of the frame it
 * announces next.
 *
 * The arming has to happen BEFORE the seek that presents the frame. Measured
 * against the live browser: register on `seeked` and the callback fires for some
 * seeks and never for others, which would quietly turn this whole path into
 * "cut roughly wherever the playhead happens to be" — the thing it exists to
 * replace. Registered first, it fires for every presentation.
 *
 * `null` means no frame was announced in time. Callers treat that as "ask
 * again", never as a position — falling back to `currentTime` here would hand
 * back the time that was ASKED for and look like a frame boundary.
 */
function armFrameTime(video: HTMLVideoElement, timeoutMs = 300): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, timeoutMs);
    video.requestVideoFrameCallback((_now, metadata) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(metadata.mediaTime);
    });
  });
}

/**
 * Land on `time` and report the presentation time of the frame shown there.
 *
 * A seek that changes nothing presents nothing, so there would be no callback to
 * await; those are forced to present by stepping away first.
 */
async function readFrameAt(video: HTMLVideoElement, time: number): Promise<number | null> {
  if (Math.abs(video.currentTime - time) < 1e-4) {
    const limit = Number.isFinite(video.duration) ? video.duration : time + 0.05;
    await seekTo(video, Math.min(limit, time + 0.05));
  }
  const armed = armFrameTime(video);
  await seekTo(video, time);
  return armed;
}

/**
 * How long one frame of this source lasts.
 *
 * Asking for a frame a little further on returns either the same frame or the
 * next one, so the FIRST offset that returns a different frame has landed
 * exactly on the next frame's timestamp — and the distance between the two is
 * the frame duration, whatever the source's rate happens to be. Calibrating once
 * up front is what lets the walk aim reliably: assuming 30fps on a 60fps source
 * skips every other frame, and on a 25fps source it duplicates them.
 */
async function discoverFrameDuration(
  video: HTMLVideoElement,
  from: number,
  firstFrame: number
): Promise<number> {
  const offsets = [1 / 240, 1 / 120, 1 / 90, 1 / 60, 1 / 50, 1 / 30, 1 / 24, 1 / 15];
  for (const offset of offsets) {
    const observed = await readFrameAt(video, from + offset);
    if (observed !== null && observed > firstFrame + 1e-6) return observed - firstFrame;
  }
  return 1 / 30;
}

/** Move the element to `time` and wait until it has a frame for it. */
async function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(video.currentTime - time) < 1e-4) return;
  await new Promise<void>((resolve, reject) => {
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("the source refused to seek"));
    };
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);
    video.currentTime = time;
  });
}

interface SteppedFrame {
  /** Seconds into the source. */
  mediaTime: number;
  /** The canvas, already drawn, ready to be wrapped in a VideoFrame. */
  canvas: HTMLCanvasElement;
}

/**
 * Walk the kept span, one frame at a time.
 *
 * Each step aims at the middle of the NEXT frame (`+1.5 × frameDuration`), which
 * is the most forgiving target when the demuxer's idea of a frame boundary and
 * the decoder's differ by a rounding error. A step that lands on the same frame
 * again — or on a frame that never announced itself — is retried a few times and
 * then the walk gives up: a short cut is a bug, but a loop that never ends is a
 * hung upload.
 *
 * Frames begin at the element showing `previous`; the draw happens there, before
 * the next seek moves it on.
 */
async function stepFrames(
  options: WebCodecsExportOptions,
  canvas: HTMLCanvasElement,
  onFrame: (frame: SteppedFrame) => void
): Promise<void> {
  const { element: video, start, end } = options;

  const first = await readFrameAt(video, Math.max(0, Math.min(start, end)));
  if (first === null) throw new Error("the source presented no frame to cut from");

  const frameDuration = await discoverFrameDuration(video, start, first);
  // Calibration left the element on a later frame; put it back on the first one,
  // which is the frame the walk is about to draw.
  await readFrameAt(video, start);

  const lastSeekable = Number.isFinite(video.duration) ? video.duration - 1e-3 : end;
  // A guard against a source that never advances: better a short clip than a
  // loop that never ends.
  const maxSteps = Math.max(30, Math.ceil((end - start) * 240));
  let previous = first;

  for (let steps = 0; steps < maxSteps; steps++) {
    if (options.isCancelled?.()) return;

    // A frame that BEGINS at or after the end is outside the kept span, so the
    // walk stops before drawing it. Checking after drawing would append one
    // frame the creator explicitly cut away.
    if (previous >= end - 1e-6) return;

    drawInto(canvas, video);
    onFrame({ mediaTime: previous, canvas });

    let target = Math.max(0, Math.min(previous + frameDuration * 1.5, lastSeekable));
    let next: number | null = null;
    for (let attempt = 0; attempt < 6 && next === null; attempt++) {
      if (options.isCancelled?.()) return;
      const observed = await readFrameAt(video, target);
      if (observed !== null && observed > previous + 1e-6) {
        next = observed;
        break;
      }
      target = Math.min(target + frameDuration, lastSeekable);
    }

    if (next === null) return;
    previous = next;
  }
}

function drawInto(canvas: HTMLCanvasElement, video: HTMLVideoElement) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2D canvas");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
}

/**
 * Cut using the file's own encoded chunks, with no seeking at all.
 *
 * Returns null — never throws — when the file cannot be read this way, which is
 * the signal for the caller to fall back to the frame walk.
 *
 * The shape of the work: demux the container, start at the last keyframe at or
 * before the cut, decode forward, and re-encode only the frames inside the kept
 * span. Everything outside it is closed immediately, so memory stays bounded by
 * the length of the cut rather than the length of the scene.
 */
async function encodeFromEncodedChunks(
  options: WebCodecsExportOptions,
  canvas: HTMLCanvasElement,
  width: number,
  height: number
): Promise<WebmFrame[] | null> {
  if (typeof window.VideoDecoder !== "function") return null;

  try {
    const bytes = new Uint8Array(await options.file.arrayBuffer());

    // Both containers are tried in turn. Either may be the wrong one for these
    // bytes — that is not an error, it is simply the next branch — and only a
    // configuration the decoder actually accepts is used, so an MP4 carrying a
    // codec this browser will not decode still falls back to the seek path.
    const webm = demuxWebm(bytes);
    if (webm.video?.codec && webm.samples.length > 0 && webm.unsupportedBlocks === 0) {
      const config: VideoDecoderConfig = { codec: webm.video.codec };
      if (webm.video.width) config.codedWidth = webm.video.width;
      if (webm.video.height) config.codedHeight = webm.video.height;
      const supported = await decoderSupports(config);
      if (supported) return await decodeAndEncode(options, webm.samples, supported, canvas, width, height);
    }

    const mp4 = demuxMp4(bytes);
    if (mp4.video?.codec && mp4.samples.length > 0 && mp4.unsupportedBlocks === 0) {
      const config: VideoDecoderConfig = { codec: mp4.video.codec };
      if (mp4.video.width) config.codedWidth = mp4.video.width;
      if (mp4.video.height) config.codedHeight = mp4.video.height;
      // H.264 needs its `avcC` record: an `avc1` stream's samples carry no
      // parameter sets, so a decoder with no description cannot start.
      if (mp4.video.description) config.description = mp4.video.description;
      const supported = await decoderSupports(config);
      if (supported) return await decodeAndEncode(options, mp4.samples, supported, canvas, width, height);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * The configuration the decoder will actually accept, or null when it will not.
 *
 * A rejection is routine — the browser may not have the codec, or the stream
 * may name it in a way it cannot use — and it is always the signal to try the
 * other path rather than to fail the export.
 */
async function decoderSupports(
  config: VideoDecoderConfig
): Promise<VideoDecoderConfig | null> {
  try {
    const support = await VideoDecoder.isConfigSupported(config);
    return support.supported ? (support.config ?? config) : null;
  } catch {
    return null;
  }
}

/**
 * Decode the samples in the kept span and re-encode them.
 *
 * A decoder can only start at a keyframe, so the feed begins at the last one at
 * or before the cut and simply skips what it produces before then.
 */
async function decodeAndEncode(
  options: WebCodecsExportOptions,
  samples: { timestampUs: number; keyframe: boolean; data: Uint8Array }[],
  config: VideoDecoderConfig,
  canvas: HTMLCanvasElement,
  width: number,
  height: number
): Promise<WebmFrame[] | null> {
  const startUs = Math.round(options.start * 1e6);
  const endUs = Math.round(options.end * 1e6);

  let from = 0;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].keyframe && samples[i].timestampUs <= startUs) from = i;
  }

  const decoded: VideoFrame[] = [];
  let decodeError: unknown = null;

  const decoder = new VideoDecoder({
    output: (frame) => {
      // The picture is what is wanted; anything outside the span is released at
      // once, so a long scene does not accumulate frames.
      if (frame.timestamp < startUs || frame.timestamp >= endUs) {
        frame.close();
        return;
      }
      decoded.push(frame);
    },
    error: (failure) => {
      decodeError = failure;
    },
  });
  decoder.configure(config);

  const duration = Math.max(0.001, options.end - options.start);

  try {
    for (let i = from; i < samples.length; i++) {
      const sample = samples[i];
      if (sample.timestampUs >= endUs) break;
      if (options.isCancelled?.()) throw new Error("cancelled");
      if (decodeError) break;

      decoder.decode(
        new EncodedVideoChunk({
          type: sample.keyframe ? "key" : "delta",
          timestamp: sample.timestampUs,
          data: sample.data,
        })
      );

      // Keep the queue short: a whole scene queued at once is a lot of frames
      // held in the decoder's memory for nothing.
      if (decoder.decodeQueueSize > 16) {
        await new Promise<void>((resolve) => {
          decoder.addEventListener("dequeue", () => resolve(), { once: true });
        });
      }
      options.onProgress?.(
        Math.min(60, Math.round(((sample.timestampUs - startUs) / (duration * 1e6)) * 60))
      );
    }

    await decoder.flush();
  } catch {
    decoder.close();
    for (const frame of decoded) frame.close();
    return null;
  } finally {
    if (decoder.state !== "closed") decoder.close();
  }

  if (decodeError || decoded.length === 0) {
    for (const frame of decoded) frame.close();
    return null;
  }

  // Decode order is not presentation order.
  decoded.sort((a, b) => a.timestamp - b.timestamp);

  const encoded: WebmFrame[] = [];
  let encodeError: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      encoded.push({
        track: VIDEO_TRACK,
        timestampUs: chunk.timestamp,
        keyframe: chunk.type === "key",
        data,
      });
    },
    error: (failure) => {
      encodeError = failure;
    },
  });
  encoder.configure({
    codec: "vp8",
    width,
    height,
    bitrate: recordingBitsPerSecond(height),
    framerate: 30,
    latencyMode: "quality",
  });

  const origin = decoded[0].timestamp;
  const framesPerKey = 30 * KEYFRAME_INTERVAL_S;

  for (let index = 0; index < decoded.length; index++) {
    const source = decoded[index];
    // Drawn rather than encoded in place: a phone clip can be 4K and odd-sized,
    // and both encoders refuse an odd dimension.
    drawFrameInto(canvas, source);
    const frame = new VideoFrame(canvas, {
      timestamp: Math.max(0, source.timestamp - origin),
      duration: Math.round(1e6 / 30),
    });
    encoder.encode(frame, { keyFrame: index % framesPerKey === 0 });
    frame.close();
    source.close();
    options.onProgress?.(60 + Math.round(((index + 1) / decoded.length) * 30));
  }

  await encoder.flush();
  encoder.close();

  if (encodeError || encoded.length === 0) return null;
  return encoded;
}

function drawFrameInto(canvas: HTMLCanvasElement, frame: VideoFrame) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2D canvas");
  context.drawImage(frame, 0, 0, canvas.width, canvas.height);
}

/** Encode the stepped frames with VideoEncoder, in presentation order. */
async function encodeVideo(
  options: WebCodecsExportOptions,
  canvas: HTMLCanvasElement,
  width: number,
  height: number
): Promise<WebmFrame[]> {
  const { start } = options;
  const chunkFrames: WebmFrame[] = [];
  let error: unknown = null;

  const encoder = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunkFrames.push({
        track: VIDEO_TRACK,
        timestampUs: chunk.timestamp,
        keyframe: chunk.type === "key",
        data,
      });
    },
    error: (failure) => {
      error = failure;
    },
  });

  encoder.configure({
    codec: "vp8",
    width,
    height,
    bitrate: recordingBitsPerSecond(height),
    framerate: 30,
    latencyMode: "quality",
  });

  let index = 0;
  const framesPerKey = 30 * KEYFRAME_INTERVAL_S;
  // Timestamps are written relative to the FIRST frame actually found, not to
  // the requested start: the frame covering `start` usually begins a little
  // before it, and clamping that to zero would hand the muxer two frames with
  // the same timestamp. The file then begins at 0 and is as long as the frames
  // it holds.
  let origin: number | null = null;

  const duration = Math.max(0.001, options.end - start);
  await stepFrames(options, canvas, ({ mediaTime, canvas: drawn }) => {
    if (error) return;
    if (origin === null) origin = mediaTime;
    const timestampUs = Math.round((mediaTime - origin) * 1e6);
    const frame = new VideoFrame(drawn, {
      timestamp: Math.max(0, timestampUs),
      duration: Math.round((1 / 30) * 1e6),
    });
    encoder.encode(frame, { keyFrame: index % framesPerKey === 0 });
    frame.close();
    index++;
    options.onProgress?.(Math.min(90, Math.round(((mediaTime - start) / duration) * 90)));
  });

  if (error) throw error;
  await encoder.flush();
  encoder.close();

  if (chunkFrames.length === 0) throw new Error("the encoder produced no frames");
  return chunkFrames;
}

/** Decode the source's audio, slice the kept span, and re-encode it as Opus. */
async function encodeAudio(
  options: WebCodecsExportOptions
): Promise<{ frames: WebmFrame[]; track: WebmAudioTrack } | null> {
  const { file, start, end } = options;
  if (!audioSupported()) return null;
  if (file.size > MAX_AUDIO_DECODE_BYTES) return null;

  let decoded: AudioBuffer;
  const context = new AudioContext();
  try {
    decoded = await context.decodeAudioData(await file.arrayBuffer());
  } catch {
    // No audio track, or a container the browser will not decode. Either way
    // the picture still exports; there is simply nothing to carry across.
    return null;
  } finally {
    void context.close();
  }

  const channels = Math.min(2, decoded.numberOfChannels) || 1;
  const kept = Math.max(0.001, end - start);
  const length = Math.max(1, Math.round(kept * OPUS_SAMPLE_RATE));

  // Resample to Opus's 48kHz by rendering the slice offline — which also cuts it
  // to exactly the kept span, so the audio matches the picture frame for frame.
  const offline = new OfflineAudioContext(channels, length, OPUS_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0, Math.min(start, decoded.duration), kept);
  const rendered = await offline.startRendering();

  const frames: WebmFrame[] = [];
  let track: WebmAudioTrack | null = null;
  let error: unknown = null;

  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      const description = metadata?.decoderConfig?.description;
      if (!track) {
        if (!description) return;
        const codecPrivate = new Uint8Array(description as ArrayBuffer);
        track = {
          sampleRate: OPUS_SAMPLE_RATE,
          channels,
          codecPrivate,
          codecDelayNs: opusCodecDelayNs(codecPrivate),
        };
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      frames.push({
        track: AUDIO_TRACK,
        timestampUs: chunk.timestamp,
        keyframe: true,
        data,
      });
    },
    error: (failure) => {
      error = failure;
    },
  });

  encoder.configure({
    codec: "opus",
    sampleRate: OPUS_SAMPLE_RATE,
    numberOfChannels: channels,
    bitrate: 96_000,
  });

  const planes = Array.from({ length: channels }, (_, channel) =>
    rendered.getChannelData(channel)
  );

  for (let offset = 0; offset < length; offset += OPUS_FRAME_SAMPLES) {
    if (error) break;
    const count = Math.min(OPUS_FRAME_SAMPLES, length - offset);
    // `f32-planar` wants every plane one after another, not interleaved.
    const planar = new Float32Array(count * channels);
    planes.forEach((plane, channel) =>
      planar.set(plane.subarray(offset, offset + count), channel * count)
    );
    encoder.encode(
      new AudioData({
        format: "f32-planar",
        sampleRate: OPUS_SAMPLE_RATE,
        numberOfFrames: count,
        numberOfChannels: channels,
        timestamp: Math.round((offset / OPUS_SAMPLE_RATE) * 1e6),
        data: planar,
      })
    );
  }

  await encoder.flush().catch(() => {});
  encoder.close();
  if (error) throw error;
  if (!track || frames.length === 0) return null;

  return { frames, track };
}

/** OpusHead carries the decoder's pre-skip, which becomes `CodecDelay`. */
function opusCodecDelayNs(codecPrivate: Uint8Array): number {
  if (codecPrivate.length < 12) return 0;
  const preSkip = codecPrivate[10] | (codecPrivate[11] << 8);
  return Math.round((preSkip / OPUS_SAMPLE_RATE) * 1e9);
}

/**
 * Cut the kept span and return the bytes of a fresh WebM.
 *
 * Throws on anything it cannot do properly — the caller treats every failure as
 * "use the other path", so a half-finished file is never handed back.
 */
export async function exportWithWebCodecs(
  options: WebCodecsExportOptions
): Promise<WebCodecsExportResult> {
  const { element: video, start, end } = options;
  if (!webCodecsExportSupported()) throw new Error("WebCodecs is not available");
  if (end - start <= 0) throw new Error("nothing to keep");

  const size = exportCanvasSize(video.videoWidth, video.videoHeight);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  drawInto(canvas, video);

  // The frames come from the file's own encoded chunks when that is possible —
  // the difference between a cut that takes as long as the clip and one that
  // takes as long as the CPU needs — and from seeking the element when it is
  // not. Both produce the same container.
  let frameSource: "decoder" | "seek" = "decoder";
  let videoFrames = await encodeFromEncodedChunks(options, canvas, size.width, size.height);
  if (!videoFrames) {
    frameSource = "seek";
    videoFrames = await encodeVideo(options, canvas, size.width, size.height);
  }

  const audio = await encodeAudio(options);

  options.onProgress?.(95);

  const frames = [...videoFrames, ...(audio?.frames ?? [])].sort(
    (a, b) => a.timestampUs - b.timestampUs
  );

  // The frame cadence learnt from the source, for the track's DefaultDuration.
  const firstTwo = videoFrames.slice(0, 2);
  const frameDurationUs =
    firstTwo.length === 2 && firstTwo[1].timestampUs > firstTwo[0].timestampUs
      ? firstTwo[1].timestampUs - firstTwo[0].timestampUs
      : Math.round(1e6 / 30);
  const frameDurationNs = frameDurationUs * 1000;

  // The file is as long as the frames it holds, not as long as the handles were
  // dragged: the last frame still has its own duration to play. The two differ
  // by at most one frame, and stating the real length is what stops a player
  // waiting on a final frame that never arrives.
  const lastUs = videoFrames[videoFrames.length - 1]?.timestampUs ?? 0;
  const durationMs = Math.max(1, Math.round((lastUs + frameDurationUs) / 1000));

  const data = buildWebm({
    video: { width: size.width, height: size.height, frameDurationNs },
    audio: audio?.track,
    durationMs,
    frames,
  });

  options.onProgress?.(100);
  return {
    data,
    width: size.width,
    height: size.height,
    hasAudio: Boolean(audio),
    frameSource,
  };
}
