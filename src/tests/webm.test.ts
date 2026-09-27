// =============================================================================
// GENHUB - the WebM writer
// =============================================================================
// The muxer hands a file straight to the browser, and a container that is even
// slightly malformed fails in the worst possible way: the creator waits for the
// cut, and the result will not play. Browser tests prove Chromium accepts it;
// these prove the structure is the one intended — the ids, the sizes, the
// duration, the ordering — which is what makes a failure here a one-line
// diagnosis instead of a mystery in a different process.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AUDIO_TRACK,
  ID,
  VIDEO_TRACK,
  buildWebm,
  demuxWebm,
  readElement,
  encodeVint,
  floatElement,
  idLength,
  uintElement,
  unknownSize,
  vint,
  type WebmFrame,
} from "@/lib/webm";

// -----------------------------------------------------------------------------
// A reader, so the output is checked as a file rather than as bytes
// -----------------------------------------------------------------------------

/** The elements directly inside `[start, end)`, using the library's own reader. */
function readChildrenOf(bytes: Uint8Array, start: number, end: number) {
  const found = [];
  let pos = start;
  while (pos < end) {
    const element = readElement(bytes, pos, end);
    found.push(element);
    if (element.end <= pos) break;
    pos = element.end;
  }
  return found;
}

interface Node {
  id: number;
  dataStart: number;
  size: number;
  unknown: boolean;
  children: Node[];
}

const MASTER = new Set<number>([
  ID.EBML,
  ID.Segment,
  ID.Info,
  ID.Tracks,
  ID.TrackEntry,
  ID.Video,
  ID.Audio,
  ID.Cluster,
]);

function readId(buf: Uint8Array, pos: number) {
  const first = buf[pos];
  let length = 1;
  while (length <= 4 && !(first & (0x80 >> (length - 1)))) length++;
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + buf[pos + i];
  return { id, length };
}

function readSize(buf: Uint8Array, pos: number) {
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

function parse(buf: Uint8Array, start: number, end: number): Node[] {
  const nodes: Node[] = [];
  let pos = start;
  while (pos < end) {
    const { id, length: idLen } = readId(buf, pos);
    const { size, length: sizeLen, unknown } = readSize(buf, pos + idLen);
    const dataStart = pos + idLen + sizeLen;
    const node: Node = { id, dataStart, size, unknown, children: [] };
    if (MASTER.has(id) && (unknown || size > 0)) {
      node.children = parse(buf, dataStart, unknown ? end : dataStart + size);
    }
    nodes.push(node);
    if (unknown) break;
    pos = dataStart + size;
  }
  return nodes;
}

function find(nodes: Node[], id: number): Node | undefined {
  return nodes.find((node) => node.id === id);
}

function all(nodes: Node[], id: number): Node[] {
  return nodes.filter((node) => node.id === id);
}

function uint(buf: Uint8Array, node: Node): number {
  let value = 0;
  for (let i = 0; i < node.size; i++) value = value * 256 + buf[node.dataStart + i];
  return value;
}

function float(buf: Uint8Array, node: Node): number {
  return new DataView(buf.buffer, buf.byteOffset + node.dataStart, 8).getFloat64(0, false);
}

function text(buf: Uint8Array, node: Node): string {
  return new TextDecoder().decode(buf.subarray(node.dataStart, node.dataStart + node.size));
}

/** Read a SimpleBlock back into what it claims to be. */
function block(buf: Uint8Array, node: Node) {
  const first = buf[node.dataStart];
  const track = first & 0x7f;
  const relative = new DataView(
    buf.buffer,
    buf.byteOffset + node.dataStart + 1,
    2
  ).getInt16(0, false);
  return {
    track,
    relative,
    keyframe: (buf[node.dataStart + 3] & 0x80) !== 0,
    payload: buf.subarray(node.dataStart + 4, node.dataStart + node.size),
  };
}

// -----------------------------------------------------------------------------

describe("EBML primitives", () => {
  it("knows how many bytes each id occupies", () => {
    expect(idLength(0xae)).toBe(1);
    expect(idLength(0x4489)).toBe(2);
    expect(idLength(0x2ad7b1)).toBe(3);
    expect(idLength(0x1a45dfa3)).toBe(4);
  });

  it("writes the shortest size that fits", () => {
    expect(Array.from(vint(0))).toEqual([0x80]);
    expect(Array.from(vint(126))).toEqual([0xfe]);
    expect(Array.from(vint(127))).toEqual([0x40, 0x7f]);
    expect(Array.from(vint(0x3ffe))).toEqual([0x7f, 0xfe]);
  });

  it("refuses a size that cannot be expressed at all", () => {
    // An all-ones size is reserved to mean "unknown", so it is one short.
    expect(() => encodeVint(0xff, 1)).toThrow();
    expect(() => encodeVint(-1, 1)).toThrow();
  });

  it("writes the unknown-size marker WebM uses for a live Segment", () => {
    expect(Array.from(unknownSize())).toEqual([
      0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);
  });

  it("writes integers in the fewest bytes", () => {
    expect(Array.from(uintElement(0xd7, 1))).toEqual([0xd7, 0x81, 0x01]);
    expect(Array.from(uintElement(0xb0, 1280))).toEqual([0xb0, 0x82, 0x05, 0x00]);
  });

  it("writes floats as big-endian doubles", () => {
    expect(Array.from(floatElement(ID.Duration, 1000))).toEqual([
      0x44, 0x89, 0x88, 0x40, 0x8f, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
  });
});

describe("buildWebm", () => {
  const video = { width: 640, height: 360, frameDurationNs: 33_333_333 };
  const audio = {
    sampleRate: 48_000,
    channels: 1,
    codecPrivate: new Uint8Array([1, 2, 3, 4]),
    codecDelayNs: 6_500_000,
  };

  const frames: WebmFrame[] = [
    { track: VIDEO_TRACK, timestampUs: 0, keyframe: true, data: new Uint8Array([1, 1, 1]) },
    {
      track: AUDIO_TRACK,
      timestampUs: 20_000,
      keyframe: true,
      data: new Uint8Array([2, 2]),
    },
    { track: VIDEO_TRACK, timestampUs: 33_333, keyframe: false, data: new Uint8Array([3, 3]) },
    {
      track: VIDEO_TRACK,
      timestampUs: 5_000_000,
      keyframe: true,
      data: new Uint8Array([4, 4]),
    },
  ];

  const built = buildWebm({ video, audio, durationMs: 5000, frames });
  const tree = parse(built, 0, built.length);

  it("opens with an EBML header declaring webm", () => {
    const header = find(tree, ID.EBML);
    expect(header).toBeDefined();
    expect(text(built, find(header!.children, ID.DocType)!)).toBe("webm");
    expect(uint(built, find(header!.children, ID.EBMLMaxIDLength)!)).toBe(4);
    expect(uint(built, find(header!.children, ID.EBMLMaxSizeLength)!)).toBe(8);
  });

  it("writes a Segment of unknown size, so nothing has to be rewritten later", () => {
    const segment = find(tree, ID.Segment)!;
    expect(segment.unknown).toBe(true);
    // Everything the file holds is inside it.
    expect(segment.children.length).toBeGreaterThan(2);
  });

  it("states the duration a player will report", () => {
    const info = find(find(tree, ID.Segment)!.children, ID.Info)!;
    expect(float(built, find(info.children, ID.Duration)!)).toBeCloseTo(5000, 3);
    expect(uint(built, find(info.children, ID.TimecodeScale)!)).toBe(1_000_000);
  });

  it("describes a VP8 video track and an Opus audio track", () => {
    const tracks = find(find(tree, ID.Segment)!.children, ID.Tracks)!;
    const entries = all(tracks.children, ID.TrackEntry);
    expect(entries).toHaveLength(2);

    const [videoEntry, audioEntry] = entries;
    expect(text(built, find(videoEntry.children, ID.CodecID)!)).toBe("V_VP8");
    expect(uint(built, find(videoEntry.children, ID.TrackNumber)!)).toBe(VIDEO_TRACK);
    const videoSettings = find(videoEntry.children, ID.Video)!;
    expect(uint(built, find(videoSettings.children, ID.PixelWidth)!)).toBe(640);
    expect(uint(built, find(videoSettings.children, ID.PixelHeight)!)).toBe(360);

    expect(text(built, find(audioEntry.children, ID.CodecID)!)).toBe("A_OPUS");
    expect(uint(built, find(audioEntry.children, ID.TrackNumber)!)).toBe(AUDIO_TRACK);
    // Without OpusHead the decoder cannot start.
    const private_ = find(audioEntry.children, ID.CodecPrivate)!;
    expect(
      Array.from(built.subarray(private_.dataStart, private_.dataStart + private_.size))
    ).toEqual([1, 2, 3, 4]);
    const audioSettings = find(audioEntry.children, ID.Audio)!;
    expect(float(built, find(audioSettings.children, ID.SamplingFrequency)!)).toBe(48_000);
    expect(uint(built, find(audioSettings.children, ID.Channels)!)).toBe(1);
  });

  it("writes every frame, in order, with its track and timecode", () => {
    const clusterList = all(find(tree, ID.Segment)!.children, ID.Cluster);
    // The third frame is a keyframe five seconds in: a new cluster for it.
    expect(clusterList).toHaveLength(2);

    const first = find(clusterList[0].children, ID.Timecode)!;
    expect(uint(built, first)).toBe(0);
    const firstBlocks = all(clusterList[0].children, ID.SimpleBlock).map((node) =>
      block(built, node)
    );
    expect(firstBlocks.map((b) => b.track)).toEqual([VIDEO_TRACK, AUDIO_TRACK, VIDEO_TRACK]);
    expect(firstBlocks.map((b) => b.relative)).toEqual([0, 20, 33]);
    expect(firstBlocks.map((b) => b.keyframe)).toEqual([true, true, false]);
    expect(Array.from(firstBlocks[0].payload)).toEqual([1, 1, 1]);

    const second = find(clusterList[1].children, ID.Timecode)!;
    expect(uint(built, second)).toBe(5000);
    const secondBlocks = all(clusterList[1].children, ID.SimpleBlock).map((node) =>
      block(built, node)
    );
    expect(secondBlocks).toHaveLength(1);
    expect(secondBlocks[0].relative).toBe(0);
    expect(Array.from(secondBlocks[0].payload)).toEqual([4, 4]);
  });

  it("omits the audio track when there is no audio", () => {
    const silent = buildWebm({ video, durationMs: 100, frames: [] });
    const tree2 = parse(silent, 0, silent.length);
    const tracks = find(find(tree2, ID.Segment)!.children, ID.Tracks)!;
    expect(all(tracks.children, ID.TrackEntry)).toHaveLength(1);
  });

  it("reads back everything it wrote", () => {
    // The strongest check available without a second implementation: the file
    // the muxer produced must describe exactly the tracks, timing and payloads
    // that went into it.
    const parsed = demuxWebm(built);

    expect(parsed.durationMs).toBeCloseTo(5000, 3);
    expect(parsed.timecodeScaleNs).toBe(1_000_000);
    expect(parsed.video).toEqual({
      trackNumber: VIDEO_TRACK,
      codec: "vp8",
      codecId: "V_VP8",
      width: 640,
      height: 360,
    });
    expect(parsed.audioTrackNumber).toBe(AUDIO_TRACK);
    expect(parsed.unsupportedBlocks).toBe(0);

    const video = parsed.samples.filter((sample) => sample.trackNumber === VIDEO_TRACK);
    // Millisecond-quantised on the way through: a WebM's timebase is the
    // TimecodeScale, so a frame at 33.333ms comes back at 33ms. That is the
    // container's resolution, not a rounding mistake.
    expect(video.map((sample) => sample.timestampUs)).toEqual([0, 33_000, 5_000_000]);
    expect(video.map((sample) => sample.keyframe)).toEqual([true, false, true]);
    expect(Array.from(video[0].data)).toEqual([1, 1, 1]);
    expect(Array.from(video[2].data)).toEqual([4, 4]);

    // Audio samples are read for their timestamps only; the picture is what the
    // export decodes from here.
    expect(parsed.samples.some((sample) => sample.trackNumber === AUDIO_TRACK)).toBe(false);
  });

  it("starts a new cluster before a SimpleBlock timecode could overflow", () => {
    const long: WebmFrame[] = Array.from({ length: 5 }, (_, i) => ({
      track: VIDEO_TRACK,
      timestampUs: i * 10_000_000,
      keyframe: false,
      data: new Uint8Array([i]),
    }));
    const file = buildWebm({ video, durationMs: 50_000, frames: long });
    const tree3 = parse(file, 0, file.length);
    const clusterList = all(find(tree3, ID.Segment)!.children, ID.Cluster);
    // 10s apart with no keyframes: split by the 4-second cap, not by keyframes.
    expect(clusterList.length).toBeGreaterThan(1);
    for (const cluster of clusterList) {
      for (const node of all(cluster.children, ID.SimpleBlock)) {
        expect(Math.abs(block(file, node).relative)).toBeLessThan(30_000);
      }
    }
  });
});

describe("demuxWebm, against real files", () => {
  const silent = new Uint8Array(readFileSync(path.resolve("e2e/fixtures/short.webm")));
  const withAudio = new Uint8Array(
    readFileSync(path.resolve("e2e/fixtures/short-with-audio.webm"))
  );

  it("reads the picture track of a file ffmpeg wrote", () => {
    const parsed = demuxWebm(silent);
    expect(parsed.video?.codec).toBe("vp8");
    expect(parsed.video?.width).toBe(320);
    expect(parsed.video?.height).toBe(240);
    expect(parsed.durationMs).toBeCloseTo(6000, 0);

    // Six seconds at 30fps, in order, evenly spaced, starting on a keyframe.
    expect(parsed.samples.length).toBe(180);
    expect(parsed.samples[0].timestampUs).toBe(0);
    expect(parsed.samples[0].keyframe).toBe(true);
    expect(parsed.unsupportedBlocks).toBe(0);
    for (let i = 1; i < parsed.samples.length; i++) {
      const gap = parsed.samples[i].timestampUs - parsed.samples[i - 1].timestampUs;
      expect(gap).toBeGreaterThan(30_000);
      expect(gap).toBeLessThan(36_000);
    }
    expect(parsed.samples[0].data.length).toBeGreaterThan(0);
  });

  it("reads a recording MediaRecorder wrote, clusters and all", () => {
    // This file is the awkward shape: an unknown-size Segment, unknown-size
    // Clusters that only end where the next one begins, and laced Opus blocks.
    const parsed = demuxWebm(withAudio);

    expect(parsed.video?.codec).toBe("vp8");
    expect(parsed.video?.width).toBe(320);
    expect(parsed.audioTrackNumber).toBe(2);

    // Roughly four seconds at 30fps. The exact count depends on how the recorder
    // started and stopped, so the range is what is asserted.
    expect(parsed.samples.length).toBeGreaterThan(100);
    expect(parsed.samples.length).toBeLessThan(140);
    expect(parsed.samples[0].keyframe).toBe(true);
    for (let i = 1; i < parsed.samples.length; i++) {
      expect(parsed.samples[i].timestampUs).toBeGreaterThan(parsed.samples[i - 1].timestampUs);
    }

    // Only the picture is handed back; the soundtrack is left to decodeAudioData.
    expect(parsed.samples.every((sample) => sample.trackNumber === parsed.video?.trackNumber)).toBe(
      true
    );
  });

  it("counts a laced block instead of guessing at it", () => {
    // Lacing packs several frames into one block, and unpacking it wrongly would
    // produce a quietly mangled cut. The reader must say so rather than try.
    const file = buildWebm({
      video: { width: 64, height: 64, frameDurationNs: 33_333_333 },
      durationMs: 1000,
      frames: [
        { track: VIDEO_TRACK, timestampUs: 0, keyframe: true, data: new Uint8Array([9, 9]) },
      ],
    });

    // Find the block and set its lacing bits (flags byte: track VINT, then two
    // bytes of timecode, then the flags).
    const top = readChildrenOf(file, 0, file.length);
    const segment = top.find((element) => element.id === ID.Segment)!;
    const cluster = readChildrenOf(file, segment.dataStart, segment.end).find(
      (element) => element.id === ID.Cluster
    )!;
    const block = readChildrenOf(file, cluster.dataStart, cluster.end).find(
      (element) => element.id === ID.SimpleBlock
    )!;
    file[block.dataStart + 3] |= 0x02;

    const parsed = demuxWebm(file);
    expect(parsed.unsupportedBlocks).toBe(1);
    expect(parsed.samples).toEqual([]);
  });

  it("returns nothing usable for bytes that are not a WebM", () => {
    // The caller treats this as "use the other path", so it must not throw.
    const parsed = demuxWebm(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(parsed.video).toBeNull();
    expect(parsed.samples).toEqual([]);
  });
});
