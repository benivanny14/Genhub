# Browser-test fixtures

Real, committed clips for the trimmer's browser tests. All are 6s at 30fps,
320x240, so the specs can share the same numbers.

- `short.webm` — VP8/WebM, no audio, with a true duration in its header.
  Regenerate with `node e2e/make-fixture.mjs`.
- `short-with-audio.webm` — ~4s, VP8 + Opus, with the `Duration` element that
  MediaRecorder omits patched into the EBML header afterwards.
  Regenerate with `node e2e/make-audio-fixture.mjs`.
- `short-h264.mp4` — H.264/MP4, no audio, **classic** MP4: the sample tables in
  `moov` are filled in, which is the shape a phone records.
- `short-h264-fragmented.mp4` — the same frames as a **fragmented** MP4
  (`moov` tables empty, media described by `moof`/`trun`), which is the shape a
  browser's MediaRecorder writes.
  Both MP4s regenerate with `node e2e/make-mp4-fixture.mjs`.

The two MP4 fixtures exist so the MP4 demuxer's fast path is tested against a
real, decodable clip rather than synthetic bytes — see the comments in
`make-mp4-fixture.mjs` for why neither Playwright's ffmpeg nor MediaRecorder can
produce a classic H.264 MP4 directly, and how it is assembled instead.

The WebM fixtures are not produced by H.264 or AAC: they are open codecs, so
they play in the exact browser the tests run in with no proprietary decoders
required. The MP4 fixtures are H.264 and are only used by the demuxer tests,
which need that codec.
