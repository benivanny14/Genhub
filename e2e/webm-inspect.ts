// =============================================================================
// GENHUB - Reading a produced WebM back, in the test process
//
// The browser test can measure a File's duration by playing it, which proves the
// file is playable but says nothing about how it is built. Frame accuracy is a
// claim about the CONTAINER — how many frames are in it, and how far apart their
// timestamps are — and that has to be read from the bytes.
//
// The File lives in the browser and this reader runs in Node, so the spec hands
// the bytes across as base64 (a few tens of KB) and parses them here.
//
// Deliberately small: it reads what the assertions need and nothing else. It is
// not a general-purpose demuxer, and it is not shared with the muxer it checks —
// a reader that agreed with the writer by construction would prove nothing.
// =============================================================================

export interface InspectedFrame {
  track: number;
  /** Presentation time in milliseconds, relative to the start of the file. */
  timeMs: number;
  keyframe: boolean;
}

export interface InspectedWebm {
  /** The Duration stated in the Info element, or null when absent. */
  durationMs: number | null;
  /** Track numbers declared in Tracks. */
  tracks: number[];
  /** Every frame found, in file order. */
  frames: InspectedFrame[];
}

const ID = {
  Segment: 0x18538067,
  Info: 0x1549a966,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
};

interface Element {
  id: number;
  dataStart: number;
  size: number;
  unknown: boolean;
}

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
  let size = first & mask;
  let unknown = size === mask;
  for (let i = 1; i < length; i++) {
    size = size * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) unknown = false;
  }
  return { size, length, unknown };
}

/** Every element directly inside `[start, end)`. */
function children(buf: Uint8Array, start: number, end: number): Element[] {
  const found: Element[] = [];
  let pos = start;
  while (pos < end) {
    const { id, length: idLen } = readId(buf, pos);
    const { size, length: sizeLen, unknown } = readSize(buf, pos + idLen);
    found.push({ id, dataStart: pos + idLen + sizeLen, size, unknown });
    if (unknown) break;
    pos = pos + idLen + sizeLen + size;
  }
  return found;
}

function uint(buf: Uint8Array, element: Element): number {
  let value = 0;
  for (let i = 0; i < element.size; i++) value = value * 256 + buf[element.dataStart + i];
  return value;
}

export function inspectWebm(bytes: Uint8Array): InspectedWebm {
  const top = children(bytes, 0, bytes.length);
  const segment = top.find((element) => element.id === ID.Segment);
  if (!segment) throw new Error("no Segment in the produced file");

  const inside = children(
    bytes,
    segment.dataStart,
    segment.unknown ? bytes.length : segment.dataStart + segment.size
  );

  const info = inside.find((element) => element.id === ID.Info);
  let durationMs: number | null = null;
  if (info) {
    const found = children(bytes, info.dataStart, info.dataStart + info.size).find(
      (element) => element.id === ID.Duration
    );
    if (found) {
      durationMs = new DataView(
        bytes.buffer,
        bytes.byteOffset + found.dataStart,
        8
      ).getFloat64(0, false);
    }
  }

  const tracksElement = inside.find((element) => element.id === ID.Tracks);
  const tracks = tracksElement
    ? children(bytes, tracksElement.dataStart, tracksElement.dataStart + tracksElement.size)
        .filter((element) => element.id === ID.TrackEntry)
        .map((entry) => {
          const number = children(
            bytes,
            entry.dataStart,
            entry.dataStart + entry.size
          ).find((element) => element.id === ID.TrackNumber);
          return number ? uint(bytes, number) : -1;
        })
    : [];

  const frames: InspectedFrame[] = [];
  for (const cluster of inside.filter((element) => element.id === ID.Cluster)) {
    const insideCluster = children(
      bytes,
      cluster.dataStart,
      cluster.unknown ? bytes.length : cluster.dataStart + cluster.size
    );
    const timecode = insideCluster.find((element) => element.id === ID.Timecode);
    const clusterMs = timecode ? uint(bytes, timecode) : 0;

    for (const block of insideCluster.filter((element) => element.id === ID.SimpleBlock)) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + block.dataStart, block.size);
      frames.push({
        track: view.getUint8(0) & 0x7f,
        timeMs: clusterMs + view.getInt16(1, false),
        keyframe: (view.getUint8(3) & 0x80) !== 0,
      });
    }
  }

  return { durationMs, tracks, frames };
}
