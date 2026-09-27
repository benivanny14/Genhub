// =============================================================================
// GENHUB - Reading an MP4 back, byte by byte
// =============================================================================
//
// lib/webm.ts gives the export its fast path: demux the container, hand the
// encoded sample chunks to VideoDecoder, and re-encode only the frames inside
// the cut. That path is bounded by the CPU rather than by how long the clip
// runs, so a three-second cut finishes in a fraction of a second.
//
// It only ever fired for WebM/VP8 sources, though. A creator's phone records
// H.264 in an MP4 (Apple and Android both do, without being asked), and those
// files fell through to the MediaRecorder path — the real-time one, whose
// boundaries land wherever the recorder happened to stop. This file closes that
// gap: it reads an MP4's sample tables and hands back the same shape of data
// `demuxWebm` does, so the export path does not care which container it came
// from.
//
// Two shapes of MP4 have to be read, because the world writes both:
//
//   1. CLASSIC MP4 — one `moov` holding per-track `stbl` tables (stts, stsc,
//      stsz, stco/co64, stss) that describe every sample up front. This is what
//      a phone writes, and what `mdat` data offset arithmetic is about.
//   2. FRAGMENTED MP4 — a `moov` whose tables are empty, followed by repeated
//      `moof`/`traf`/`trun` fragments that carry the sizes, durations and flags
//      inline. This is what a browser's MediaRecorder writes, so a clip cut and
//      uploaded inside the app can come back here too.
//
// It is deliberately a READER only, and pure byte arithmetic with no DOM, so it
// is exercised in Node against real files and against hand-built bytes.
//
// What it does not do: edit lists (`elst`) are ignored, so a file that shifts
// its first presentation by an edit list keeps the shift. That is at most a
// fraction of a second at the very start, and every frame boundary the export
// seeks to is a genuine keyframe boundary from this reader, so a cut is still
// frame-exact relative to what this reader reports.
// =============================================================================

/** A box header, and where its payload begins. */
export interface Mp4Box {
  /** Four-character type, e.g. `moov`, `stbl`, `avc1`. */
  type: string;
  /** Offset of the box's first byte (its size field). */
  start: number;
  /** Size of the box header: 8, or 16 when a 64-bit size is used. */
  headerSize: number;
  /** Offset of the first payload byte. */
  dataStart: number;
  /** Offset just past the box. */
  end: number;
}

/** Boxes whose payload is a list of child boxes. */
const CONTAINER = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "dinf",
  "edts",
  "mvex",
  "moof",
  "traf",
  "mfra",
]);

// -----------------------------------------------------------------------------
// Box walking
// -----------------------------------------------------------------------------

function boxType(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

/**
 * Every box directly inside `[start, end)`.
 *
 * `size === 0` means "to the end of the file", which only ever appears on the
 * last box, so it is clamped rather than rejected. A box whose declared size is
 * smaller than its own header would otherwise be a way to loop forever, so it
 * stops the walk instead.
 */
function readBoxes(bytes: Uint8Array, start: number, end: number): Mp4Box[] {
  const found: Mp4Box[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = u32(bytes, pos);
    let headerSize = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      size = u64(bytes, pos + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < headerSize || pos + size > end) break;
    found.push({
      type: boxType(bytes, pos + 4),
      start: pos,
      headerSize,
      dataStart: pos + headerSize,
      end: pos + size,
    });
    pos += size;
  }
  return found;
}

function children(bytes: Uint8Array, box: Mp4Box): Mp4Box[] {
  return readBoxes(bytes, box.dataStart, box.end);
}

function find(boxes: Mp4Box[], type: string): Mp4Box | undefined {
  return boxes.find((box) => box.type === type);
}

// -----------------------------------------------------------------------------
// Reading numbers
// -----------------------------------------------------------------------------

function u16(bytes: Uint8Array, at: number): number {
  return (bytes[at] << 8) | bytes[at + 1];
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] * 0x1000000 + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3]) >>> 0;
}

function i32(bytes: Uint8Array, at: number): number {
  return (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
}

/** A 64-bit value, as a JS number. Sample tables never exceed 2^53 in practice. */
function u64(bytes: Uint8Array, at: number): number {
  return u32(bytes, at) * 0x100000000 + u32(bytes, at + 4);
}

/** The version and flags of a "full box", which change how its body is laid out. */
function versionFlags(bytes: Uint8Array, box: Mp4Box): { version: number; flags: number } {
  return { version: bytes[box.dataStart], flags: (u16(bytes, box.dataStart + 2) << 8) >>> 8 };
}

/** A 16.16 fixed-point number, as MP4 states a track's width and height. */
function fixed16(bytes: Uint8Array, at: number): number {
  return u32(bytes, at) / 65536;
}

// -----------------------------------------------------------------------------
// The reader's result
// -----------------------------------------------------------------------------

export interface Mp4VideoTrack {
  /** The track id, used to pick it out of a fragmented file's fragments. */
  trackId: number;
  /** Four-character sample entry type: `avc1`, `av01`, `vp09`, … */
  codecId: string;
  /** The WebCodecs codec string, or null when this reader cannot name it. */
  codec: string | null;
  width: number;
  height: number;
  /**
   * The decoder configuration record (`avcC`/`av1C`/`vpcC`), which H.264 in
   * particular REQUIRES: an `avc1` stream's samples carry no parameter sets
   * inline, so a decoder with no `description` cannot decode the first frame.
   */
  description?: Uint8Array;
}

export interface Mp4Sample {
  /** Presentation time in microseconds, from the track's own timebase. */
  timestampUs: number;
  keyframe: boolean;
  data: Uint8Array;
}

export interface DemuxedMp4 {
  /** Stated playing time in milliseconds, when the file says so. */
  durationMs: number | null;
  video: Mp4VideoTrack | null;
  /** Video samples, in file order. */
  samples: Mp4Sample[];
  /** Samples this reader could not interpret, which is why the fast path fails. */
  unsupportedBlocks: number;
  /** True when the samples came from `moof` fragments rather than `stbl` tables. */
  fragmented: boolean;
}

// -----------------------------------------------------------------------------
// Codec naming
// -----------------------------------------------------------------------------

function hex2(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, "0");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Name the codec, and pull out the decoder configuration it needs.
 *
 * H.264's string is `avc1.PPCCLL` — the profile, the compatibility flags and
 * the level from the `avcC` record's first four bytes. AV1 and VP9 state theirs
 * differently but just as mechanically. HEVC is recognised but left unnamed:
 * Chromium on this platform does not decode it anyway, and inventing a string
 * for a codec the decoder will refuse only moves the failure later.
 */
function readCodec(
  bytes: Uint8Array,
  entry: Mp4Box
): { codec: string | null; description?: Uint8Array } {
  const inside = readBoxes(bytes, entry.dataStart + 78, entry.end);
  const descriptionOf = (type: string): Uint8Array | undefined => {
    const box = find(inside, type);
    return box ? bytes.subarray(box.dataStart, box.end) : undefined;
  };

  switch (entry.type) {
    case "avc1":
    case "avc3": {
      const avcC = descriptionOf("avcC");
      if (!avcC || avcC.length < 4) return { codec: null };
      // `avc3` means the parameter sets may also appear inline; the name is the
      // same shape either way.
      const codec = `${entry.type}.${hex2(avcC[1])}${hex2(avcC[2])}${hex2(avcC[3])}`;
      return { codec, description: avcC };
    }
    case "av01": {
      const av1C = descriptionOf("av1C");
      if (!av1C || av1C.length < 3) return { codec: null };
      // byte 1: marker(1) version(7) | seq_profile(3) seq_level_idx_0(5)
      const profile = (av1C[1] >> 5) & 0x07;
      const level = av1C[1] & 0x1f;
      // byte 2: seq_tier_0(1) high_bitdepth(1) twelve_bit(1) monochrome(1) …
      const tier = (av1C[2] >> 7) & 1 ? "H" : "M";
      const highBitDepth = (av1C[2] >> 6) & 1;
      const twelveBit = (av1C[2] >> 5) & 1;
      const bitDepth = highBitDepth ? (twelveBit ? 12 : 10) : 8;
      return {
        codec: `av01.${profile}.${pad2(level)}${tier}.${pad2(bitDepth)}`,
        description: av1C,
      };
    }
    case "vp09": {
      const vpcC = descriptionOf("vpcC");
      if (!vpcC || vpcC.length < 6) return { codec: null };
      // full box: version(1) flags(3), then profile(1) level(1) bitDepth(4)…
      const profile = vpcC[4];
      const level = vpcC[5];
      const bitDepth = (vpcC[6] >> 4) & 0x0f;
      return {
        codec: `vp09.${pad2(profile)}.${pad2(level)}.${pad2(bitDepth)}`,
        description: vpcC,
      };
    }
    default:
      return { codec: null };
  }
}

// -----------------------------------------------------------------------------
// The video track, from moov
// -----------------------------------------------------------------------------

interface TrackInfo {
  trackId: number;
  timescale: number;
  stbl: Mp4Box;
  width: number;
  height: number;
  codecId: string;
  codec: string | null;
  description?: Uint8Array;
}

/** The first track whose handler says it is a picture. */
function findVideoTrack(bytes: Uint8Array, moov: Mp4Box): TrackInfo | null {
  for (const trak of children(bytes, moov).filter((box) => box.type === "trak")) {
    const mdia = find(children(bytes, trak), "mdia");
    if (!mdia) continue;
    const mdiaChildren = children(bytes, mdia);

    const hdlr = find(mdiaChildren, "hdlr");
    if (!hdlr) continue;
    // handler_type sits after version/flags(4) and pre_defined(4).
    if (boxType(bytes, hdlr.dataStart + 8) !== "vide") continue;

    const mdhd = find(mdiaChildren, "mdhd");
    if (!mdhd) continue;
    const { version } = versionFlags(bytes, mdhd);
    const timescale = u32(bytes, mdhd.dataStart + (version === 1 ? 20 : 12));

    const tkhd = find(children(bytes, trak), "tkhd");
    const trackId = tkhd ? u32(bytes, tkhd.dataStart + 12) : 1;
    // The matrix and dimensions are the LAST eight bytes of tkhd, at either
    // version. Sizes are fixed 16.16.
    const width = tkhd ? fixed16(bytes, tkhd.end - 8) : 0;
    const height = tkhd ? fixed16(bytes, tkhd.end - 4) : 0;

    const minf = find(mdiaChildren, "minf");
    if (!minf) continue;
    const stblBox = find(children(bytes, minf), "stbl");
    if (!stblBox) continue;

    const stsd = find(children(bytes, stblBox), "stsd");
    if (!stsd) continue;
    // full box: version/flags(4) entry_count(4), then the sample entries.
    const entries = readBoxes(bytes, stsd.dataStart + 8, stsd.end);
    const entry = entries[0];
    if (!entry) continue;

    const named = readCodec(bytes, entry);
    // The picture's real size is in the sample entry, which is what the decoder
    // will be configured with; tkhd only carries the presentation size.
    const entryWidth = u16(bytes, entry.dataStart + 24);
    const entryHeight = u16(bytes, entry.dataStart + 26);

    return {
      trackId,
      timescale: timescale || 1,
      stbl: stblBox,
      width: entryWidth || Math.round(width),
      height: entryHeight || Math.round(height),
      codecId: entry.type,
      codec: named.codec,
      description: named.description,
    };
  }
  return null;
}

// -----------------------------------------------------------------------------
// Classic MP4: the sample tables
// -----------------------------------------------------------------------------

function tableEntries(bytes: Uint8Array, box: Mp4Box, stride: number): number {
  return Math.floor((box.end - (box.dataStart + 8)) / stride);
}

/** Sample sizes, from either the plain `stsz` or the compact `stz2`. */
function readSampleSizes(bytes: Uint8Array, stbl: Mp4Box[]): number[] | null {
  const stsz = find(stbl, "stsz");
  if (stsz) {
    const uniform = u32(bytes, stsz.dataStart + 4);
    const count = u32(bytes, stsz.dataStart + 8);
    if (uniform !== 0) return new Array(count).fill(uniform);
    const sizes: number[] = [];
    for (let i = 0; i < count; i++) sizes.push(u32(bytes, stsz.dataStart + 12 + i * 4));
    return sizes;
  }

  const stz2 = find(stbl, "stz2");
  if (stz2) {
    const fieldSize = bytes[stz2.dataStart + 7];
    const count = u32(bytes, stz2.dataStart + 8);
    const sizes: number[] = [];
    if (fieldSize === 16) {
      for (let i = 0; i < count; i++) sizes.push(u16(bytes, stz2.dataStart + 12 + i * 2));
    } else if (fieldSize === 8) {
      for (let i = 0; i < count; i++) sizes.push(bytes[stz2.dataStart + 12 + i]);
    } else {
      // 4-bit samples are packed two to a byte, high nibble first.
      for (let i = 0; i < count; i++) {
        const byte = bytes[stz2.dataStart + 12 + (i >> 1)];
        sizes.push(i % 2 === 0 ? byte >> 4 : byte & 0x0f);
      }
    }
    return sizes;
  }

  return null;
}

/** Decode times for every sample, in track timescale units (the "dts"). */
function readDecodeTimes(bytes: Uint8Array, stbl: Mp4Box[], count: number): number[] | null {
  const stts = find(stbl, "stts");
  if (!stts) return null;
  const entryCount = u32(bytes, stts.dataStart + 4);
  const starts: number[] = [];
  let time = 0;
  for (let i = 0; i < entryCount; i++) {
    const at = stts.dataStart + 8 + i * 8;
    const repeats = u32(bytes, at);
    const delta = u32(bytes, at + 4);
    for (let n = 0; n < repeats && starts.length < count; n++) starts.push(time + n * delta);
    time += repeats * delta;
  }
  while (starts.length < count) starts.push(time);
  return starts;
}

/** Composition offsets, from `ctts`, when the file has them. */
function readCompositionOffsets(
  bytes: Uint8Array,
  stbl: Mp4Box[],
  count: number
): number[] {
  const ctts = find(stbl, "ctts");
  if (!ctts) return new Array(count).fill(0);
  const version = bytes[ctts.dataStart];
  const entryCount = u32(bytes, ctts.dataStart + 4);
  const offsets: number[] = [];
  for (let i = 0; i < entryCount && offsets.length < count; i++) {
    const at = ctts.dataStart + 8 + i * 8;
    const repeats = u32(bytes, at);
    const offset = version === 1 ? i32(bytes, at + 4) : u32(bytes, at + 4);
    for (let n = 0; n < repeats && offsets.length < count; n++) offsets.push(offset);
  }
  while (offsets.length < count) offsets.push(0);
  return offsets;
}

/** Absolute byte offset of each sample, from the chunk offsets and `stsc`. */
function readSampleOffsets(bytes: Uint8Array, stbl: Mp4Box[], sizes: number[]): number[] | null {
  const stco = find(stbl, "stco");
  const co64 = find(stbl, "co64");
  if (!stco && !co64) return null;

  const chunkCount = u32(bytes, (stco ?? co64)!.dataStart + 4);
  const chunkOffset = (index: number): number =>
    stco
      ? u32(bytes, stco.dataStart + 8 + index * 4)
      : u64(bytes, co64!.dataStart + 8 + index * 8);

  const stsc = find(stbl, "stsc");
  if (!stsc) return null;
  const entryCount = u32(bytes, stsc.dataStart + 4);
  const runs: { firstChunk: number; samplesPerChunk: number }[] = [];
  for (let i = 0; i < entryCount; i++) {
    const at = stsc.dataStart + 8 + i * 12;
    runs.push({ firstChunk: u32(bytes, at), samplesPerChunk: u32(bytes, at + 4) });
  }
  if (runs.length === 0) return null;

  // Walk the chunks, laying samples down one after another inside each one.
  const offsets: number[] = [];
  let sample = 0;
  for (let chunk = 1; chunk <= chunkCount && sample < sizes.length; chunk++) {
    let samplesPerChunk = runs[0].samplesPerChunk;
    for (const run of runs) {
      if (run.firstChunk <= chunk) samplesPerChunk = run.samplesPerChunk;
    }
    let at = chunkOffset(chunk - 1);
    for (let n = 0; n < samplesPerChunk && sample < sizes.length; n++, sample++) {
      offsets.push(at);
      at += sizes[sample];
    }
  }
  return offsets.length === sizes.length ? offsets : null;
}

/** Whether each sample is a keyframe, from `stss`. No table means all of them. */
function readSyncSamples(bytes: Uint8Array, stbl: Mp4Box[], count: number): boolean[] {
  const stss = find(stbl, "stss");
  if (!stss) return new Array(count).fill(true);
  const entryCount = u32(bytes, stss.dataStart + 4);
  const synced = new Array(count).fill(false);
  for (let i = 0; i < entryCount; i++) {
    const number = u32(bytes, stss.dataStart + 8 + i * 4);
    if (number >= 1 && number <= count) synced[number - 1] = true;
  }
  return synced;
}

function readClassicSamples(bytes: Uint8Array, track: TrackInfo): Mp4Sample[] {
  const stbl = children(bytes, track.stbl);
  const sizes = readSampleSizes(bytes, stbl);
  if (!sizes || sizes.length === 0) return [];

  const decode = readDecodeTimes(bytes, stbl, sizes.length);
  const composition = readCompositionOffsets(bytes, stbl, sizes.length);
  const offsets = readSampleOffsets(bytes, stbl, sizes);
  if (!decode || !offsets) return [];

  const sync = readSyncSamples(bytes, stbl, sizes.length);
  const toUs = (units: number) => Math.round((units * 1_000_000) / track.timescale);

  const samples: Mp4Sample[] = [];
  for (let i = 0; i < sizes.length; i++) {
    const at = offsets[i];
    const size = sizes[i];
    if (at + size > bytes.length) break;
    samples.push({
      timestampUs: toUs(decode[i] + composition[i]),
      keyframe: sync[i],
      data: bytes.subarray(at, at + size),
    });
  }
  return samples;
}

// -----------------------------------------------------------------------------
// Fragmented MP4: the moof fragments
// -----------------------------------------------------------------------------

interface TrexDefaults {
  duration: number;
  size: number;
  flags: number;
}

const TRUN_DATA_OFFSET = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS = 0x000004;
const TRUN_SAMPLE_DURATION = 0x000100;
const TRUN_SAMPLE_SIZE = 0x000200;
const TRUN_SAMPLE_FLAGS = 0x000400;
const TRUN_SAMPLE_CTS = 0x000800;

const TFHD_BASE_DATA_OFFSET = 0x000001;
const TFHD_DEFAULT_SAMPLE_DURATION = 0x000008;
const TFHD_DEFAULT_SAMPLE_SIZE = 0x000010;
const TFHD_DEFAULT_SAMPLE_FLAGS = 0x000020;
const TFHD_DEFAULT_BASE_IS_MOOF = 0x020000;

/** A sample's flags say it is NOT a sync sample in bit 16. */
function sampleIsSync(flags: number): boolean {
  return (flags & 0x00010000) === 0;
}

function readTrexDefaults(bytes: Uint8Array, moov: Mp4Box, trackId: number): TrexDefaults | null {
  const mvex = find(children(bytes, moov), "mvex");
  if (!mvex) return null;
  for (const trex of children(bytes, mvex).filter((box) => box.type === "trex")) {
    if (u32(bytes, trex.dataStart + 4) !== trackId) continue;
    // track_id(4) default_sample_description_index(4) duration(4) size(4) flags(4)
    return {
      duration: u32(bytes, trex.dataStart + 12),
      size: u32(bytes, trex.dataStart + 16),
      flags: u32(bytes, trex.dataStart + 20),
    };
  }
  return null;
}

function readFragmentedSamples(
  bytes: Uint8Array,
  moov: Mp4Box,
  track: TrackInfo
): Mp4Sample[] {
  const defaults = readTrexDefaults(bytes, moov, track.trackId) ?? {
    duration: 0,
    size: 0,
    flags: 0,
  };
  const toUs = (units: number) => Math.round((units * 1_000_000) / track.timescale);
  const samples: Mp4Sample[] = [];

  for (const box of readBoxes(bytes, 0, bytes.length)) {
    if (box.type !== "moof") continue;
    for (const traf of children(bytes, box).filter((child) => child.type === "traf")) {
      const kind = children(bytes, traf);
      const tfhd = find(kind, "tfhd");
      if (!tfhd) continue;
      if (u32(bytes, tfhd.dataStart + 4) !== track.trackId) continue;

      // tfhd: version/flags(4) track_id(4), then optional fields in flag order.
      const tfhdFlags = u32(bytes, tfhd.dataStart) & 0x00ffffff;
      let cursor = tfhd.dataStart + 8;
      let baseDataOffset = box.start;
      if (tfhdFlags & TFHD_BASE_DATA_OFFSET) {
        baseDataOffset = u64(bytes, cursor);
        cursor += 8;
      } else if (!(tfhdFlags & TFHD_DEFAULT_BASE_IS_MOOF)) {
        // No base given and not moof-relative: the spec falls back to the first
        // byte of this fragment, which is what `box.start` already is.
        baseDataOffset = box.start;
      }
      if (tfhdFlags & 0x000002) cursor += 4; // sample_description_index

      let defaultDuration = defaults.duration;
      let defaultSize = defaults.size;
      let defaultFlags = defaults.flags;
      if (tfhdFlags & TFHD_DEFAULT_SAMPLE_DURATION) {
        defaultDuration = u32(bytes, cursor);
        cursor += 4;
      }
      if (tfhdFlags & TFHD_DEFAULT_SAMPLE_SIZE) {
        defaultSize = u32(bytes, cursor);
        cursor += 4;
      }
      if (tfhdFlags & TFHD_DEFAULT_SAMPLE_FLAGS) {
        defaultFlags = u32(bytes, cursor);
        cursor += 4;
      }

      // tfdt gives the decode time this fragment continues from.
      let decodeTime = 0;
      const tfdt = find(kind, "tfdt");
      if (tfdt) {
        decodeTime = bytes[tfdt.dataStart] === 1
          ? u64(bytes, tfdt.dataStart + 4)
          : u32(bytes, tfdt.dataStart + 4);
      }

      for (const trun of kind.filter((child) => child.type === "trun")) {
        const trunFlags = u32(bytes, trun.dataStart) & 0x00ffffff;
        const count = u32(bytes, trun.dataStart + 4);
        let at = trun.dataStart + 8;
        let dataOffset = 0;
        if (trunFlags & TRUN_DATA_OFFSET) {
          dataOffset = i32(bytes, at);
          at += 4;
        }
        let firstSampleFlags: number | null = null;
        if (trunFlags & TRUN_FIRST_SAMPLE_FLAGS) {
          firstSampleFlags = u32(bytes, at);
          at += 4;
        }

        let sampleOffset = baseDataOffset + dataOffset;
        for (let i = 0; i < count; i++) {
          const duration = trunFlags & TRUN_SAMPLE_DURATION ? u32(bytes, at) : defaultDuration;
          if (trunFlags & TRUN_SAMPLE_DURATION) at += 4;
          const size = trunFlags & TRUN_SAMPLE_SIZE ? u32(bytes, at) : defaultSize;
          if (trunFlags & TRUN_SAMPLE_SIZE) at += 4;
          const flags =
            trunFlags & TRUN_SAMPLE_FLAGS
              ? u32(bytes, at)
              : i === 0 && firstSampleFlags !== null
                ? firstSampleFlags
                : defaultFlags;
          if (trunFlags & TRUN_SAMPLE_FLAGS) at += 4;
          const cts = trunFlags & TRUN_SAMPLE_CTS ? i32(bytes, at) : 0;
          if (trunFlags & TRUN_SAMPLE_CTS) at += 4;

          if (size > 0 && sampleOffset + size <= bytes.length) {
            samples.push({
              timestampUs: toUs(decodeTime + cts),
              keyframe: sampleIsSync(flags),
              data: bytes.subarray(sampleOffset, sampleOffset + size),
            });
          }
          sampleOffset += size;
          decodeTime += duration;
        }
      }
    }
  }
  return samples;
}

// -----------------------------------------------------------------------------
// The file
// -----------------------------------------------------------------------------

/** Stated playing time, from `mvhd`, in milliseconds. */
function readDurationMs(bytes: Uint8Array, moov: Mp4Box): number | null {
  const mvhd = find(children(bytes, moov), "mvhd");
  if (!mvhd) return null;
  const version = bytes[mvhd.dataStart];
  const timescale = u32(bytes, mvhd.dataStart + (version === 1 ? 20 : 12));
  const duration =
    version === 1 ? u64(bytes, mvhd.dataStart + 24) : u32(bytes, mvhd.dataStart + 16);
  if (!timescale || !duration) return null;
  return (duration / timescale) * 1000;
}

/**
 * Read an MP4's video track and samples.
 *
 * Bytes that are not an MP4 at all are not an error: the caller uses an empty
 * result as "take the other path", exactly as it does for WebM.
 */
export function demuxMp4(bytes: Uint8Array): DemuxedMp4 {
  const result: DemuxedMp4 = {
    durationMs: null,
    video: null,
    samples: [],
    unsupportedBlocks: 0,
    fragmented: false,
  };

  try {
    const moov = find(readBoxes(bytes, 0, bytes.length), "moov");
    if (!moov) return result;

    const track = findVideoTrack(bytes, moov);
    if (!track) return result;

    result.video = {
      trackId: track.trackId,
      codecId: track.codecId,
      codec: track.codec,
      width: track.width,
      height: track.height,
      description: track.description,
    };
    result.durationMs = readDurationMs(bytes, moov);

    const classic = readClassicSamples(bytes, track);
    if (classic.length > 0) {
      result.samples = classic;
    } else {
      // An empty `stbl` means the samples live in fragments instead.
      result.fragmented = true;
      result.samples = readFragmentedSamples(bytes, moov, track);
    }
  } catch {
    // A malformed file is the caller's cue to fall back, not a crash.
  }

  return result;
}
