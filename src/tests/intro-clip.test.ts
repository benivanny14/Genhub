import { describe, it, expect } from "vitest";
import {
  parseMasterVariants,
  pickClipVariant,
  parseMediaPlaylist,
  planClipSegments,
  buildClipManifest,
  INTRO_CLIP_WINDOW_SECONDS,
} from "@/lib/intro-clip";

// The shapes below are copies of what the live pull zone actually answered for
// the two hosted scenes (probed from video.bunnycdn.com and the CDN, not typed
// from memory): a four-variant master, and media playlists of 4.000s segments.
const MASTER = `#EXTM3U
#EXT-X-VERSION:3

#EXT-X-STREAM-INF:BANDWIDTH=1206584,AVERAGE-BANDWIDTH=880214,CODECS="avc1.64001e,mp4a.40.2",RESOLUTION=360x640,CLOSED-CAPTIONS=NONE
360p/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1834504,AVERAGE-BANDWIDTH=1328544,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=480x854,CLOSED-CAPTIONS=NONE
480p/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3214048,AVERAGE-BANDWIDTH=2299622,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=720x1280,CLOSED-CAPTIONS=NONE
720p/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=551592,AVERAGE-BANDWIDTH=423099,CODECS="avc1.64000d,mp4a.40.2",RESOLUTION=198x352,CLOSED-CAPTIONS=NONE
240p/video.m3u8
`;

function media(segments: number, duration = 4.0, ext = "ts") {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:4",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
  ];
  for (let i = 0; i < segments; i++) {
    lines.push(`#EXTINF:${duration.toFixed(6)},`);
    lines.push(`video${i}.${ext}`);
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}

describe("parseMasterVariants", () => {
  it("reads every rendition with its bandwidth and resolution", () => {
    const variants = parseMasterVariants(MASTER);
    expect(variants.map((v) => v.uri)).toEqual([
      "360p/video.m3u8",
      "480p/video.m3u8",
      "720p/video.m3u8",
      "240p/video.m3u8",
    ]);
    expect(variants[0].bandwidth).toBe(1206584);
    expect(variants[0].width).toBe(360);
    expect(variants[0].height).toBe(640);
  });

  it("returns nothing for a body that is not a master playlist", () => {
    expect(parseMasterVariants(media(3))).toEqual([]);
    expect(parseMasterVariants("")).toEqual([]);
  });
});

describe("pickClipVariant", () => {
  it("takes the cheapest rendition that is at least 360p on its short side", () => {
    const picked = pickClipVariant(parseMasterVariants(MASTER));
    // 240p (352 short side) is refused; 360p is chosen over the pricier ones.
    expect(picked?.uri).toBe("360p/video.m3u8");
  });

  it("reads portrait uploads by their short side, not their height", () => {
    const picked = pickClipVariant(
      parseMasterVariants(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=720x1280
720p/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=360x640
360p/video.m3u8
`)
    );
    expect(picked?.uri).toBe("360p/video.m3u8");
  });

  it("falls back to the best available when nothing reaches 360", () => {
    const picked = pickClipVariant(
      parseMasterVariants(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=144x256
144p/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=198x352
240p/video.m3u8
`)
    );
    expect(picked?.uri).toBe("240p/video.m3u8");
  });

  it("returns null for an empty master", () => {
    expect(pickClipVariant([])).toBeNull();
  });
});

describe("parseMediaPlaylist", () => {
  it("keeps the order and the duration of every segment", () => {
    const parsed = parseMediaPlaylist(media(16));
    expect(parsed.segments).toHaveLength(16);
    expect(parsed.segments[0]).toMatchObject({ uri: "video0.ts", duration: 4 });
    expect(parsed.targetDuration).toBe(4);
    expect(parsed.version).toBe(3);
  });

  it("carries an encryption key only until the playlist turns it off", () => {
    const body = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1
#EXTINF:4.000000,
video0.ts
#EXTINF:4.000000,
video1.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:4.000000,
video2.ts
`;
    const parsed = parseMediaPlaylist(body);
    expect(parsed.segments[0].key).toMatchObject({ method: "AES-128", uri: "key.bin" });
    expect(parsed.segments[1].key?.uri).toBe("key.bin");
    expect(parsed.segments[2].key).toBeNull();
  });

  it("carries the init map for fMP4 renditions", () => {
    const body = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.000000,
chunk0.m4s
#EXTINF:4.000000,
chunk1.m4s
`;
    const parsed = parseMediaPlaylist(body);
    expect(parsed.segments.map((s) => s.mapUri)).toEqual(["init.mp4", "init.mp4"]);
    expect(parsed.segments.map((s) => s.uri)).toEqual(["chunk0.m4s", "chunk1.m4s"]);
  });
});

describe("planClipSegments", () => {
  it("takes the opening, the middle, further in, and the end", () => {
    // 16 segments x 4s = 60.3s, which is the real Stepdad playlist.
    const segments = Array.from({ length: 16 }, (_, i) => ({
      duration: i === 15 ? 0.3 : 4,
    }));
    const plan = planClipSegments(segments);
    // Targets are 0, 18.8, 37.5 and 56.3 seconds into the 60.3s scene.
    expect(plan.indices).toEqual([0, 4, 9, 14]);
    expect(plan.duration).toBeCloseTo(16, 5);
    expect(plan.sourceDuration).toBeCloseTo(60.3, 5);
  });

  it("never lets the intro cover more than half the scene", () => {
    // The real 30.8s playlist (the shorter of the two hosted scenes): four
    // windows would be more than half of it, so three are cut instead.
    const plan = planClipSegments(
      Array.from({ length: 8 }, () => ({ duration: 30.8 / 8 }))
    );
    expect(plan.indices).toHaveLength(3);
    expect(plan.duration).toBeLessThanOrEqual(plan.sourceDuration / 2 + 0.001);
  });

  it("always leaves at least one segment out, however short the scene", () => {
    const plan = planClipSegments(Array.from({ length: 2 }, () => ({ duration: 4 })));
    expect(plan.indices).toHaveLength(1);
    // With only room for one piece, it is the OPENING — never the end.
    expect(plan.indices[0]).toBe(0);
  });

  it("refuses to cut a scene that is only one segment long", () => {
    // Any window over a single-segment scene IS the whole scene.
    const plan = planClipSegments([{ duration: 3 }]);
    expect(plan.indices).toEqual([]);
    expect(plan.duration).toBe(0);
  });

  it("returns nothing for an empty or durationless playlist", () => {
    expect(planClipSegments([]).indices).toEqual([]);
    expect(planClipSegments([{ duration: 0 }, { duration: 0 }]).indices).toEqual([]);
  });

  it("honours a custom window length", () => {
    const segments = Array.from({ length: 20 }, () => ({ duration: 2 }));
    const plan = planClipSegments(segments, { windowSeconds: 2, windows: 3 });
    expect(plan.indices).toHaveLength(3);
    expect(plan.duration).toBeLessThanOrEqual(6);
  });
});

describe("buildClipManifest", () => {
  const sign = (path: string) => `https://cdn.example.com/scene/${path}?token=signed&expires=1`;

  function build(overrides: Partial<Parameters<typeof buildClipManifest>[0]> = {}) {
    const parsed = parseMediaPlaylist(media(16));
    return buildClipManifest({
      segments: parsed.segments,
      indices: [0, 5, 9, 14],
      directory: "360p/",
      signUrl: sign,
      version: parsed.version,
      ...overrides,
    });
  }

  it("names only the planned segments, signed for one file each", () => {
    const manifest = build();
    const uris = manifest.split("\n").filter((line) => line.startsWith("https://"));
    expect(uris).toHaveLength(4);
    expect(uris[0]).toBe(sign("360p/video0.ts"));
    expect(uris[3]).toBe(sign("360p/video14.ts"));
    // The scene's other twelve segments are nowhere in the body.
    for (const index of [1, 2, 3, 4, 6, 7, 8, 10, 11, 12, 13, 15]) {
      expect(manifest).not.toContain(encodeURIComponent(`video${index}.ts`));
      expect(manifest).not.toContain(`video${index}.ts`);
    }
  });

  it("separates the windows with a discontinuity and declares a VOD playlist", () => {
    const manifest = build();
    expect(manifest.split("\n")[0]).toBe("#EXTM3U");
    expect(manifest).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(manifest.trim().endsWith("#EXT-X-ENDLIST")).toBe(true);
    // One discontinuity between each pair of windows — never before the first.
    expect(manifest.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(3);
  });

  it("keeps the target duration at or above the longest piece", () => {
    const parsed = parseMediaPlaylist(media(16));
    const manifest = build({
      segments: parsed.segments,
      indices: [0],
      directory: "360p/",
    });
    const target = Number(manifest.match(/#EXT-X-TARGETDURATION:(\d+)/)?.[1]);
    expect(target).toBeGreaterThanOrEqual(4);
  });

  it("signs the key file and the init map when the rendition has them", () => {
    const body = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x99
${Array.from({ length: 4 }, (_, i) => `#EXTINF:4.000000,\nchunk${i}.m4s`).join("\n")}
`;
    const parsed = parseMediaPlaylist(body);
    const manifest = buildClipManifest({
      segments: parsed.segments,
      indices: [0, 3],
      directory: "360p/",
      signUrl: sign,
      version: parsed.version,
    });
    expect(manifest).toContain(`#EXT-X-MAP:URI="${sign("360p/init.mp4")}"`);
    expect(manifest).toContain(`METHOD=AES-128`);
    expect(manifest).toContain(`URI="${sign("360p/key.bin")}"`);
    expect(manifest).toContain("IV=0x99");
  });

  it("returns an empty body rather than a broken playlist when nothing was planned", () => {
    expect(build({ indices: [] })).toBe("");
    expect(build({ indices: [999] })).toBe("");
  });

  it("never signs a segment outside the scene's own folder", () => {
    const parsed = parseMediaPlaylist(media(16));
    const manifest = buildClipManifest({
      segments: parsed.segments.map((s) => ({ ...s, uri: "https://elsewhere.example/x.ts" })),
      indices: [0],
      directory: "360p/",
      signUrl: sign,
    });
    expect(manifest).not.toContain("token=signed");
  });
});

describe("INTRO_CLIP_WINDOW_SECONDS", () => {
  it("matches the segment length Bunny actually produces", () => {
    // The plan assumes one segment per window; Bunny cuts at 4.000000s.
    expect(INTRO_CLIP_WINDOW_SECONDS).toBe(4);
  });
});
