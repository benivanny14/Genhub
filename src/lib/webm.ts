// =============================================================================
// GENHUB - Reading and writing WebM, byte by byte
// =============================================================================
//
// Why this file exists.
//
// Trimming used to mean playing the kept span into a canvas and re-recording it
// with MediaRecorder. That works everywhere and costs nothing to maintain, but
// it runs in real time — a 30-second cut is a 30-second wait — and its
// boundaries land wherever the recorder happened to start and stop, not on the
// frames the creator chose.
//
// The WebCodecs path in lib/video-export-webcodecs.ts fixes both, but WebCodecs
// hands back ENCODED CHUNKS, not a file: VideoEncoder produces VP8 frames and
// AudioEncoder produces Opus packets, and something has to put them in a
// container. There is no muxer in this project and none in the platform. This is
// that muxer, and it is written here as pure byte arithmetic — no DOM, no
// browser — so the file it produces can be parsed back and checked in Node.
//
// The subset of EBML/WebM written here is the smallest one Chromium accepts:
// an unknown-length Segment (the same shape MediaRecorder writes), Info with a
// real Duration, one video and optionally one audio TrackEntry, and Clusters of
// SimpleBlocks. Everything else in the specification — Cues, SeekHead, tags,
// chapters — is optional, and skipping it keeps this small enough to trust.
//
// The same file also READS WebM back (`demuxWebm`), which is what lets the
// export path hand encoded chunks straight to VideoDecoder instead of seeking
// the <video> element frame by frame. Writer and reader live together because
// they are the same body of knowledge about the format, and both are pure byte
// arithmetic with no DOM — so both are exercised in Node.
// =============================================================================

/** EBML/WebM element ids, as they are written. */
export const ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,

  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Duration: 0x4489,

  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa,
  SeekPreRoll: 0x56bb,
  DefaultDuration: 0x23e383,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,

  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
} as const;

/** `TimecodeScale` is fixed at the EBML default: one millisecond per unit. */
export const TIMECODE_SCALE_NS = 1_000_000;

/** The track numbers this muxer writes. WebM only has room for one of each here. */
export const VIDEO_TRACK = 1;
export const AUDIO_TRACK = 2;

/** A new cluster is started at least this often, in milliseconds. */
const MAX_CLUSTER_MS = 4_000;

/** A SimpleBlock's timecode is signed 16-bit, relative to its cluster. */
const MAX_RELATIVE_MS = 30_000;

// -----------------------------------------------------------------------------
// EBML primitives
// -----------------------------------------------------------------------------

/**
 * How many bytes an element id occupies.
 *
 * Ids carry their own length: the first byte's leading zeros, down to the first
 * 1, say how many bytes follow. So an id of `n` bytes falls in
 * `[2^(7n), 2^(7n+1))` — `0xAE` is one byte, `0x4489` two, `0x1A45DFA3` four.
 */
export function idLength(id: number): number {
  for (let n = 1; n <= 4; n++) {
    if (id >= 2 ** (7 * n) && id < 2 ** (7 * n + 1)) return n;
  }
  throw new Error(`0x${id.toString(16)} is not a valid EBML id`);
}

/**
 * Encode a size as a variable-length integer of exactly `length` bytes.
 *
 * Capped at seven bytes: a VINT can be eight, but the eight-byte range starts
 * past 2^53, where a JavaScript number can no longer count one at a time. The
 * only eight-byte value WebM needs is the unknown-size marker, which is written
 * literally by `unknownSize()`.
 */
export function encodeVint(value: number, length: number): Uint8Array {
  if (length < 1 || length > 7) {
    throw new Error(`a ${length}-byte VINT is not supported`);
  }
  const max = 2 ** (7 * length) - 1;
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${value} does not fit in a ${length}-byte VINT`);
  }
  const out = new Uint8Array(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i--) {
    // `% 256`, not `& 0xff`: a VINT can be eight bytes wide, and the bitwise
    // operators in JavaScript silently truncate to 32 bits — which turned the
    // unknown-size marker (2^56 - 1) into seven zero bytes and a mangled file.
    out[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

/** The shortest size encoding that fits `value`. */
export function vint(value: number): Uint8Array {
  for (let length = 1; length <= 7; length++) {
    if (value <= 2 ** (7 * length) - 2) return encodeVint(value, length);
  }
  throw new Error(`${value} is too large for an EBML size`);
}

/**
 * `0x01 FF FF FF FF FF FF FF` — the size meaning "this element is open-ended".
 *
 * Spelled out rather than encoded: the marker is 2^56 - 1, and a double cannot
 * hold that value exactly, so arithmetic on it silently produces 2^56.
 */
export function unknownSize(): Uint8Array {
  return new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
}

function id(id: number): Uint8Array {
  const length = idLength(id);
  const out = new Uint8Array(length);
  let value = id;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** An element with a known size. */
export function element(elementId: number, payload: Uint8Array): Uint8Array {
  return concat([id(elementId), vint(payload.length), payload]);
}

/** An element whose size is left open — legal, and what a live muxer writes. */
export function openElement(elementId: number): Uint8Array {
  return concat([id(elementId), unknownSize()]);
}

/** An unsigned integer in the fewest bytes that hold it, as EBML wants. */
export function uintElement(elementId: number, value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${value} is not an unsigned integer`);
  }
  const bytes: number[] = [];
  let remaining = value;
  do {
    bytes.unshift(remaining % 256);
    remaining = Math.floor(remaining / 256);
  } while (remaining > 0);
  return element(elementId, new Uint8Array(bytes));
}

/** A 64-bit IEEE float, which is how EBML states a duration or a sample rate. */
export function floatElement(elementId: number, value: number): Uint8Array {
  const payload = new Uint8Array(8);
  new DataView(payload.buffer).setFloat64(0, value, false);
  return element(elementId, payload);
}

export function stringElement(elementId: number, text: string): Uint8Array {
  return element(elementId, new TextEncoder().encode(text));
}

// -----------------------------------------------------------------------------
// The file
// -----------------------------------------------------------------------------

export interface WebmVideoTrack {
  width: number;
  height: number;
  /** Nanoseconds per frame, so a player knows the nominal frame rate. */
  frameDurationNs: number;
}

export interface WebmAudioTrack {
  sampleRate: number;
  channels: number;
  /** `OpusHead`, straight from the encoder's decoder config. */
  codecPrivate: Uint8Array;
  /** Samples the decoder must discard, in nanoseconds. */
  codecDelayNs?: number;
}

export interface WebmFrame {
  track: typeof VIDEO_TRACK | typeof AUDIO_TRACK;
  /** Presentation time in microseconds, as WebCodecs reports it. */
  timestampUs: number;
  /** Video keyframes are flagged; every Opus packet is independently decodable. */
  keyframe: boolean;
  data: Uint8Array;
}

export interface WebmInput {
  video: WebmVideoTrack;
  audio?: WebmAudioTrack;
  /** Playing time of the file, in milliseconds. */
  durationMs: number;
  /** Frames and packets, in the order they should be written. */
  frames: WebmFrame[];
  app?: string;
}

function ebmlHeader(app: string): Uint8Array {
  return element(
    ID.EBML,
    concat([
      uintElement(ID.EBMLVersion, 1),
      uintElement(ID.EBMLReadVersion, 1),
      uintElement(ID.EBMLMaxIDLength, 4),
      uintElement(ID.EBMLMaxSizeLength, 8),
      stringElement(ID.DocType, "webm"),
      uintElement(ID.DocTypeVersion, 2),
      uintElement(ID.DocTypeReadVersion, 2),
      stringElement(ID.MuxingApp, app),
    ])
  );
}

function infoElement(durationMs: number, app: string): Uint8Array {
  return element(
    ID.Info,
    concat([
      uintElement(ID.TimecodeScale, TIMECODE_SCALE_NS),
      stringElement(ID.MuxingApp, app),
      stringElement(ID.WritingApp, app),
      // The element MediaRecorder omits — and the reason a re-recorded clip has
      // to be re-seeked to learn its length. Here it is known up front.
      floatElement(ID.Duration, durationMs),
    ])
  );
}

function tracksElement(video: WebmVideoTrack, audio?: WebmAudioTrack): Uint8Array {
  const videoTrack = element(
    ID.TrackEntry,
    concat([
      uintElement(ID.TrackNumber, VIDEO_TRACK),
      uintElement(ID.TrackUID, VIDEO_TRACK),
      uintElement(ID.TrackType, 1),
      stringElement(ID.CodecID, "V_VP8"),
      uintElement(ID.DefaultDuration, video.frameDurationNs),
      element(
        ID.Video,
        concat([
          uintElement(ID.PixelWidth, video.width),
          uintElement(ID.PixelHeight, video.height),
        ])
      ),
    ])
  );

  const parts = [videoTrack];

  if (audio) {
    parts.push(
      element(
        ID.TrackEntry,
        concat([
          uintElement(ID.TrackNumber, AUDIO_TRACK),
          uintElement(ID.TrackUID, AUDIO_TRACK),
          uintElement(ID.TrackType, 2),
          stringElement(ID.CodecID, "A_OPUS"),
          element(ID.CodecPrivate, audio.codecPrivate),
          ...(audio.codecDelayNs ? [uintElement(ID.CodecDelay, audio.codecDelayNs)] : []),
          // Opus needs 80ms of pre-roll to decode a seek correctly.
          uintElement(ID.SeekPreRoll, 80_000_000),
          element(
            ID.Audio,
            concat([
              floatElement(ID.SamplingFrequency, audio.sampleRate),
              uintElement(ID.Channels, audio.channels),
            ])
          ),
        ])
      )
    );
  }

  return element(ID.Tracks, concat(parts));
}

function simpleBlock(frame: WebmFrame, clusterTimecodeMs: number): Uint8Array {
  const relative = Math.round(frame.timestampUs / 1000) - clusterTimecodeMs;
  // track number (1) + relative timecode (2) + flags (1) + the frame itself.
  const payload = new Uint8Array(4 + frame.data.length);
  // Track number as a VINT: one byte, because there are never more than 126 tracks.
  payload[0] = 0x80 | frame.track;
  new DataView(payload.buffer).setInt16(1, relative, false);
  payload[3] = frame.keyframe ? 0x80 : 0x00;
  payload.set(frame.data, 4);
  return element(ID.SimpleBlock, payload);
}

/**
 * Group frames into clusters.
 *
 * A cluster is the unit a player seeks and buffers by, so the grouping follows
 * the two things that matter: a video keyframe is a natural place to start one,
 * and a SimpleBlock's timecode is only 16 bits — a clip that ran past ~32s in a
 * single cluster would overflow it. Splitting on keyframes also means a player
 * seeking to a cluster boundary lands on a frame it can decode.
 */
function clusters(input: WebmInput): Uint8Array[] {
  const out: Uint8Array[] = [];
  let current: WebmFrame[] = [];
  let currentTimecode = 0;

  const flush = () => {
    if (current.length === 0) return;
    out.push(
      element(
        ID.Cluster,
        concat([
          uintInteger(ID.Timecode, currentTimecode),
          ...current.map((frame) => simpleBlock(frame, currentTimecode)),
        ])
      )
    );
    current = [];
  };

  for (const frame of input.frames) {
    const timeMs = Math.round(frame.timestampUs / 1000);
    if (current.length > 0) {
      const tooLong = timeMs - currentTimecode >= MAX_CLUSTER_MS;
      const overflow = timeMs - currentTimecode >= MAX_RELATIVE_MS;
      const restart = frame.track === VIDEO_TRACK && frame.keyframe;
      if (tooLong || overflow || restart) flush();
    }
    if (current.length === 0) currentTimecode = timeMs;
    current.push(frame);
  }
  flush();

  return out;
}

/** `uintElement` without the element wrapper, for a payload written by hand. */
function uintInteger(elementId: number, value: number): Uint8Array {
  return uintElement(elementId, value);
}

/**
 * Build the complete file.
 *
 * The Segment's size is left unknown on purpose. WebM allows it, MediaRecorder
 * writes it that way, and every player that can open a recorded clip can open
 * this — which means the header does not have to be rewritten once the length
 * of the body is finally known.
 */
export function buildWebm(input: WebmInput): Uint8Array<ArrayBuffer> {
  const app = input.app ?? "genhub";
  const parts = [
    ebmlHeader(app),
    openElement(ID.Segment),
    infoElement(input.durationMs, app),
    tracksElement(input.video, input.audio),
    ...clusters(input),
  ];
  return concat(parts);
}

// =============================================================================
// Reading a WebM back
// =============================================================================
//
// This is the half that makes the export fast. An <video> element can only be
// asked for a frame by seeking to it, and a seek that presents a frame costs
// about a frame interval — so walking a clip frame by frame can never beat real
// time. Encoded chunks are a different story: hand them to VideoDecoder and the
// frames come out as fast as the CPU can decode them, which for a short clip is
// tens of times faster than wall clock.
//
// Only what the export needs is read: the track declarations, and the video
// samples with their timestamps and keyframe flags. Audio is left to
// decodeAudioData, which already slices and resamples it exactly.
//
// It is tolerant of the two shapes real files come in — known-size elements (what
// this module writes, and what ffmpeg writes) and the unknown-size Segment that
// MediaRecorder writes — because a creator's file is whatever their recorder
// produced.

export interface ElementHeader {
  id: number;
  /** Offset of the first byte of the payload. */
  dataStart: number;
  /** Payload length, or the rest of the buffer when the size is unknown. */
  size: number;
  unknown: boolean;
  /** Offset just past this element. */
  end: number;
}

/** Read the element header at `pos`. */
export function readElement(bytes: Uint8Array, pos: number, limit: number): ElementHeader {
  const first = bytes[pos];
  if (first === undefined) throw new Error("truncated EBML");

  let idBytes = 1;
  while (idBytes <= 4 && !(first & (0x80 >> (idBytes - 1)))) idBytes++;
  if (idBytes > 4) throw new Error("invalid EBML id");

  let id = 0;
  for (let i = 0; i < idBytes; i++) id = id * 256 + bytes[pos + i];

  const sizeFirst = bytes[pos + idBytes];
  let sizeBytes = 1;
  while (sizeBytes <= 8 && !(sizeFirst & (0x80 >> (sizeBytes - 1)))) sizeBytes++;
  const mask = 0xff >> sizeBytes;
  let size = sizeFirst & mask;
  let unknown = size === mask;
  for (let i = 1; i < sizeBytes; i++) {
    size = size * 256 + bytes[pos + idBytes + i];
    if (bytes[pos + idBytes + i] !== 0xff) unknown = false;
  }

  const dataStart = pos + idBytes + sizeBytes;
  if (unknown) return { id, dataStart, size: limit - dataStart, unknown, end: limit };
  return { id, dataStart, size, unknown, end: dataStart + size };
}

/** Every element directly inside `[start, end)`. */
function readChildren(bytes: Uint8Array, start: number, end: number): ElementHeader[] {
  const found: ElementHeader[] = [];
  let pos = start;
  while (pos < end) {
    const element = readElement(bytes, pos, end);
    // A zero-length element at the same offset would loop forever.
    if (element.end <= pos) break;
    found.push(element);
    pos = element.end;
  }
  return found;
}

function readUnsigned(bytes: Uint8Array, element: ElementHeader): number {
  let value = 0;
  for (let i = 0; i < element.size; i++) value = value * 256 + bytes[element.dataStart + i];
  return value;
}

function readFloat(bytes: Uint8Array, element: ElementHeader): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + element.dataStart, element.size);
  return element.size === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false);
}

function readString(bytes: Uint8Array, element: ElementHeader): string {
  return new TextDecoder().decode(
    bytes.subarray(element.dataStart, element.dataStart + element.size)
  );
}

export interface DemuxedVideoTrack {
  trackNumber: number;
  /** The WebCodecs codec string, or null when this reader cannot decode it. */
  codec: "vp8" | "vp9" | null;
  codecId: string;
  width: number;
  height: number;
}

export interface DemuxedSample {
  trackNumber: number;
  /** Presentation time in microseconds, from the file's own timebase. */
  timestampUs: number;
  keyframe: boolean;
  data: Uint8Array;
}

export interface DemuxedWebm {
  timecodeScaleNs: number;
  /** Stated playing time in milliseconds, when the file says so. */
  durationMs: number | null;
  video: DemuxedVideoTrack | null;
  audioTrackNumber: number | null;
  /** Video samples, in file order. */
  samples: DemuxedSample[];
  /** Blocks this reader could not interpret, which is why the fast path fails. */
  unsupportedBlocks: number;
}

/**
 * Read a WebM's tracks and video samples.
 *
 * Lacing — several frames packed into one block — is counted as unsupported
 * rather than guessed at. It is used for audio in practice, never for video, and
 * a wrong guess here would produce a silently mangled cut. Unsupported blocks
 * make the caller fall back to the seek path, which is slow but never wrong.
 */
export function demuxWebm(bytes: Uint8Array): DemuxedWebm {
  const result: DemuxedWebm = {
    timecodeScaleNs: TIMECODE_SCALE_NS,
    durationMs: null,
    video: null,
    audioTrackNumber: null,
    samples: [],
    unsupportedBlocks: 0,
  };

  try {
    readInto(bytes, result);
  } catch {
    // Bytes that are not a WebM at all are not an error here: the caller uses an
    // empty result as "take the other path".
  }
  return result;
}

function readInto(bytes: Uint8Array, result: DemuxedWebm): void {
  const top = readChildren(bytes, 0, bytes.length);
  const segment = top.find((element) => element.id === ID.Segment);
  if (!segment) return;

  const inside = readChildren(bytes, segment.dataStart, segment.end);

  const info = inside.find((element) => element.id === ID.Info);
  if (info) {
    for (const child of readChildren(bytes, info.dataStart, info.end)) {
      if (child.id === ID.TimecodeScale) result.timecodeScaleNs = readUnsigned(bytes, child);
      if (child.id === ID.Duration) result.durationMs = readFloat(bytes, child);
    }
  }

  const tracks = inside.find((element) => element.id === ID.Tracks);
  if (tracks) {
    for (const entry of readChildren(bytes, tracks.dataStart, tracks.end)) {
      if (entry.id !== ID.TrackEntry) continue;
      const children = readChildren(bytes, entry.dataStart, entry.end);
      const number = children.find((child) => child.id === ID.TrackNumber);
      const type = children.find((child) => child.id === ID.TrackType);
      const codecId = children.find((child) => child.id === ID.CodecID);
      if (!number || !type) continue;

      if (readUnsigned(bytes, type) === 2) {
        result.audioTrackNumber = readUnsigned(bytes, number);
        continue;
      }

      const id = codecId ? readString(bytes, codecId) : "";
      const settings = children.find((child) => child.id === ID.Video);
      const videoChildren = settings
        ? readChildren(bytes, settings.dataStart, settings.end)
        : [];
      const width = videoChildren.find((child) => child.id === ID.PixelWidth);
      const height = videoChildren.find((child) => child.id === ID.PixelHeight);

      result.video = {
        trackNumber: readUnsigned(bytes, number),
        codecId: id,
        codec: id === "V_VP8" ? "vp8" : id === "V_VP9" ? "vp9" : null,
        width: width ? readUnsigned(bytes, width) : 0,
        height: height ? readUnsigned(bytes, height) : 0,
      };
    }
  }

  // Cluster timecodes and block timecodes are in TimecodeScale units, which is
  // one millisecond in every file that matters — but the scale is a field, so it
  // is read rather than assumed.
  const timecodeScale = result.timecodeScaleNs || TIMECODE_SCALE_NS;
  const toMicroseconds = (units: number) => Math.round((units * timecodeScale) / 1_000);

  // Clusters are read one at a time. An unknown-size Cluster ends where the next
  // one begins, which is the only boundary marker a streaming recording leaves.
  let pos = segment.dataStart;
  while (pos < segment.end) {
    const cluster = readElement(bytes, pos, segment.end);
    if (cluster.id !== ID.Cluster) {
      if (cluster.end <= pos) break;
      pos = cluster.end;
      continue;
    }
    let clusterTimecodeMs = 0;
    let childPos = cluster.dataStart;
    while (childPos < cluster.end) {
      const child = readElement(bytes, childPos, cluster.end);
      if (child.end <= childPos) break;

      if (child.id === ID.Cluster) break; // The next cluster starts here.
      if (child.id === ID.Timecode) clusterTimecodeMs = readUnsigned(bytes, child);

      if (child.id === ID.SimpleBlock) {
        // A SimpleBlock says so in its own flags byte.
        readBlock(bytes, child, clusterTimecodeMs, toMicroseconds, result, null);
      }

      if (child.id === ID.BlockGroup) {
        // A BlockGroup wraps a Block, and a Block does NOT carry the keyframe
        // flag: a group is a keyframe when it holds no ReferenceBlock. Chrome's
        // MediaRecorder writes its frames this way, so without this branch a
        // recording reads back as a file with no samples at all.
        const group = readChildren(bytes, child.dataStart, child.end);
        const block = group.find((element) => element.id === ID.Block);
        const referenced = group.some((element) => element.id === ID.ReferenceBlock);
        if (block) {
          readBlock(bytes, block, clusterTimecodeMs, toMicroseconds, result, !referenced);
        }
      }

      childPos = child.end;
    }

    pos = cluster.unknown ? childPos : cluster.end;
    if (cluster.unknown && childPos >= cluster.end) break;
  }
}

/**
 * Interpret one SimpleBlock (or Block) and, if it is one video frame, keep it.
 *
 * Layout: the track number as a VINT, a signed 16-bit timecode relative to the
 * cluster, a flags byte, then the frame. Bits 1-2 of the flags are the lacing
 * mode; anything but "none" is left alone rather than guessed at.
 *
 * `keyframe` is passed in because the two containers disagree: a SimpleBlock
 * carries the flag itself, while a Block inside a BlockGroup does not — the
 * group is a keyframe precisely when it references no other block.
 */
function readBlock(
  bytes: Uint8Array,
  block: ElementHeader,
  clusterTimecodeMs: number,
  toMicroseconds: (units: number) => number,
  out: DemuxedWebm,
  keyframe: boolean | null
): void {
  const first = bytes[block.dataStart];
  let trackBytes = 1;
  while (trackBytes <= 4 && !(first & (0x80 >> (trackBytes - 1)))) trackBytes++;
  let trackNumber = first & (0xff >> trackBytes);
  for (let i = 1; i < trackBytes; i++) {
    trackNumber = trackNumber * 256 + bytes[block.dataStart + i];
  }

  const payload = block.dataStart + trackBytes;
  if (payload + 3 > block.end) return;

  const relative = new DataView(bytes.buffer, bytes.byteOffset + payload, 2).getInt16(0, false);
  const flags = bytes[payload + 2];
  const laced = (flags & 0x06) !== 0;
  const dataStart = payload + 3;

  // Audio is left to decodeAudioData; only the picture is read here.
  if (trackNumber !== out.video?.trackNumber || dataStart >= block.end) {
    if (laced) out.unsupportedBlocks++;
    return;
  }

  if (laced) {
    out.unsupportedBlocks++;
    return;
  }

  out.samples.push({
    trackNumber,
    timestampUs: toMicroseconds(clusterTimecodeMs + relative),
    keyframe: keyframe ?? (flags & 0x80) !== 0,
    data: bytes.subarray(dataStart, block.end),
  });
}
