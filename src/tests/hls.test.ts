// =============================================================================
// GENHUB - HLS manifest rewriting
//
// This is the piece that makes playback actually work, and it is pure string
// work — which is exactly why it is tested here rather than discovered in a
// browser.
//
// The failure it prevents: Bunny takes a token only in the QUERY STRING, and an
// HLS player resolves the relative URLs inside a manifest against the manifest's
// own URL, dropping its query string. Hand the player a signed CDN manifest and
// the manifest loads, then every rendition and every segment 403s — a poster, a
// spinner, and no video. So every URI that leaves this function has to carry its
// own authorisation, in all four places Bunny puts one:
//
//   bare lines (variant playlists, segments), and the URI="…" attribute of
//   #EXT-X-MAP, #EXT-X-KEY, #EXT-X-MEDIA and #EXT-X-I-FRAME-STREAM-INF.
//
// The manifest bodies below are the shapes Bunny actually emits (captured from
// the live pull zone), including its CRLF line endings.
// =============================================================================

import { describe, it, expect } from "vitest";
import { rewriteHlsManifest } from "@/lib/hls";

const GUID = "39ea50b0-bee6-4175-90fe-99710ecc3848";
const CDN = "vz-test.b-cdn.net";
const QUERY = "token=AbC-123_xyz&expires=1790336657";

const MASTER = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "",
  '#EXT-X-STREAM-INF:BANDWIDTH=1014185,AVERAGE-BANDWIDTH=891231,CODECS="avc1.64001e,mp4a.40.2",RESOLUTION=358x640,CLOSED-CAPTIONS=NONE',
  "360p/video.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=535640,AVERAGE-BANDWIDTH=477099,CODECS="avc1.64000d,mp4a.40.2",RESOLUTION=198x352,CLOSED-CAPTIONS=NONE',
  "240p/video.m3u8",
].join("\r\n");

const MEDIA = [
  "#EXTM3U",
  "#EXT-X-VERSION:3",
  "#EXT-X-TARGETDURATION:4",
  "#EXT-X-MEDIA-SEQUENCE:0",
  "#EXT-X-PLAYLIST-TYPE:VOD",
  "#EXTINF:4.000,",
  "video0.ts",
  "#EXTINF:4.000,",
  "video1.ts",
  "#EXT-X-ENDLIST",
].join("\r\n");

const base = { cdnHostname: CDN, bunnyVideoId: GUID, cdnQuery: QUERY };

const master = () =>
  rewriteHlsManifest(MASTER, { ...base, proxyHref: "/api/videos/row-1/stream", directory: "" });

const media = (proxyHref = "/api/videos/row-1/stream") =>
  rewriteHlsManifest(MEDIA, { ...base, proxyHref, directory: "360p/" });

describe("rewriteHlsManifest - nested playlists", () => {
  it("sends each rendition back through our own route, which rewrites it too", () => {
    const lines = master().split("\n");

    expect(lines).toContain("/api/videos/row-1/stream?path=360p%2Fvideo.m3u8");
    expect(lines).toContain("/api/videos/row-1/stream?path=240p%2Fvideo.m3u8");
  });

  it("keeps the stream metadata a player needs to build its quality menu", () => {
    const output = master();

    expect(output).toContain("#EXT-X-STREAM-INF:BANDWIDTH=1014185");
    expect(output).toContain("RESOLUTION=358x640");
    expect(output).toContain("#EXTM3U");
    expect(output).toContain("#EXT-X-VERSION:3");
  });

  it("preserves the blank line separation instead of collapsing the manifest", () => {
    expect(master().split("\n")[2]).toBe("");
  });

  it("carries the teaser marker through to nested levels", () => {
    const output = rewriteHlsManifest(MASTER, {
      ...base,
      proxyHref: "/api/videos/row-1/stream?source=teaser",
      directory: "",
    });

    expect(output).toContain("/api/videos/row-1/stream?path=360p%2Fvideo.m3u8&source=teaser");
  });
});

describe("rewriteHlsManifest - segments", () => {
  it("gives every segment its own authorised CDN URL", () => {
    const lines = media().split("\n");

    expect(lines).toContain(`https://${CDN}/${GUID}/360p/video0.ts?${QUERY}`);
    expect(lines).toContain(`https://${CDN}/${GUID}/360p/video1.ts?${QUERY}`);
    // No bare relative segment survives: those are the requests that would 403.
    expect(lines).not.toContain("video0.ts");
    expect(lines).not.toContain("video1.ts");
  });

  it("leaves the timing tags alone", () => {
    const output = media();
    expect(output).toContain("#EXTINF:4.000,");
    expect(output).toContain("#EXT-X-ENDLIST");
    expect(output).toContain("#EXT-X-TARGETDURATION:4");
  });

  it("resolves a root-relative segment that already names the video folder", () => {
    const body = ["#EXTM3U", `/${GUID}/360p/video0.ts`].join("\n");
    const output = rewriteHlsManifest(body, { ...base, proxyHref: "/api/videos/row-1/stream" });

    expect(output).toContain(`https://${CDN}/${GUID}/360p/video0.ts?${QUERY}`);
  });

  it("resolves a ../ segment without leaving the video's folder", () => {
    const body = ["#EXTM3U", "../audio/track.aac"].join("\n");
    const output = rewriteHlsManifest(body, {
      ...base,
      proxyHref: "/api/videos/row-1/stream",
      directory: "360p/",
    });

    expect(output).toContain(`https://${CDN}/${GUID}/audio/track.aac?${QUERY}`);
  });
});

describe("rewriteHlsManifest - URI attributes", () => {
  it("authorises an initialisation map", () => {
    const output = rewriteHlsManifest(
      ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"', "#EXTINF:4.000,", "video0.m4s"].join("\n"),
      { ...base, proxyHref: "/api/videos/row-1/stream", directory: "360p/" }
    );

    expect(output).toContain(`URI="https://${CDN}/${GUID}/360p/init.mp4?${QUERY}"`);
    expect(output).toContain(`https://${CDN}/${GUID}/360p/video0.m4s?${QUERY}`);
  });

  it("authorises an encryption key but keeps the tag's own attributes", () => {
    const output = rewriteHlsManifest(
      ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.test/k.bin",IV=0x1'].join("\n"),
      { ...base, proxyHref: "/api/videos/row-1/stream" }
    );

    expect(output).toContain("METHOD=AES-128");
    expect(output).toContain("IV=0x1");
    // A key on another host is not ours to authorise.
    expect(output).toContain('URI="https://keys.test/k.bin"');
  });

  it("authorises an alternate rendition's URI", () => {
    const output = rewriteHlsManifest(
      [
        "#EXTM3U",
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",URI="audio/en.m3u8"',
      ].join("\n"),
      { ...base, proxyHref: "/api/videos/row-1/stream" }
    );

    expect(output).toContain('URI="/api/videos/row-1/stream?path=audio%2Fen.m3u8"');
  });
});

describe("rewriteHlsManifest - never doubles up", () => {
  it("leaves a URL that already carries a token exactly as it is", () => {
    const signed = `https://${CDN}/${GUID}/360p/video0.ts?token=already&expires=1`;
    const output = rewriteHlsManifest(["#EXTM3U", signed].join("\n"), {
      ...base,
      proxyHref: "/api/videos/row-1/stream",
    });

    expect(output).toContain(signed);
    expect(output).not.toContain("token=already&expires=1?");
  });

  it("leaves another host's URLs untouched", () => {
    const foreign = "https://other-cdn.test/segment.ts";
    const output = rewriteHlsManifest(["#EXTM3U", foreign].join("\n"), {
      ...base,
      proxyHref: "/api/videos/row-1/stream",
    });

    expect(output).toContain(foreign);
  });
});
