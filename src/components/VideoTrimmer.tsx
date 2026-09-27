"use client";

// =============================================================================
// GENHUB - Trim a video and watch the cut before it is uploaded
// =============================================================================
//
// Why this exists: a creator picked a file and it went straight to Bunny, whole.
// Every false start, every tail, every second of fiddling with the phone was
// paid for in upload time, storage and transcode — and shipped to viewers.
//
// This is the step in front of that. The file is loaded locally, the creator
// drags two handles to mark the part worth keeping, watches exactly that span
// loop, and only then does anything leave the device. The cut itself is a real
// re-encode done by the browser (canvas + MediaRecorder + Web Audio), because
// there is no ffmpeg and no server media worker in this project — see
// lib/video-trim.ts for the arithmetic that is kept out of this component so it
// can be tested without a browser.
//
// The component never uploads. It hands the caller either the trimmed File or
// the original one, and the caller keeps owning the upload.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, Pause, Play, Scissors, X } from "lucide-react";
import {
  MIN_TRIM_SECONDS,
  baseMimeType,
  clampTrimRange,
  exportCanvasSize,
  formatTimecode,
  isFullRange,
  outputFileName,
  pickTrimMimeType,
  recordingBitsPerSecond,
  trimDuration,
  type TrimRange,
} from "@/lib/video-trim";

interface VideoTrimmerProps {
  /** The file the creator just picked. */
  file: File;
  onCancel: () => void;
  /** Receives the file to upload, and whether it was actually trimmed. */
  onConfirm: (file: File, trimmed: boolean) => void;
}

export default function VideoTrimmer({ file, onCancel, onConfirm }: VideoTrimmerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [range, setRange] = useState<TrimRange>({ start: 0, end: 0 });
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [canTrim, setCanTrim] = useState<boolean | null>(null);

  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // The export runs against its own off-screen <video>; this flag is the one
  // way it can be told to give up (the Cancel button while encoding).
  const cancelRef = useRef(false);
  const dragRef = useRef<{ pointerId: number; target: "start" | "end" | "seek" } | null>(null);

  // The object URL is created and revoked by the SAME effect — an effect that
  // only revokes, paired with a memoised URL, hands a double-invoked mount a
  // URL the previous cleanup already killed, and the preview shows a broken
  // element with nothing wrong with the file. (Same trap ImageCropper documents.)
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Feature detection has to happen after mount: reading it during render would
  // differ between the server pass and the client and trip hydration.
  useEffect(() => {
    const supported =
      typeof window !== "undefined" &&
      typeof window.MediaRecorder !== "undefined" &&
      typeof window.AudioContext !== "undefined" &&
      typeof HTMLCanvasElement.prototype.captureStream === "function";
    setCanTrim(supported);
  }, []);

  // Escape closes the dialog — but never mid-encode, where it would silently
  // leave a half-written file with no feedback.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !exporting) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, exporting]);

  const minLength = Math.min(MIN_TRIM_SECONDS, duration || MIN_TRIM_SECONDS);
  const kept = trimDuration(range);
  const fullRange = isFullRange(range, duration);

  function handleLoadedMetadata() {
    const video = videoRef.current;
    if (!video) return;
    const total = Number.isFinite(video.duration) ? video.duration : 0;
    setDuration(total);
    setRange({ start: 0, end: total });
    setCurrentTime(0);
  }

  /** Keep the in-player playhead inside the kept span while previewing. */
  function handleTimeUpdate() {
    const video = videoRef.current;
    if (!video) return;
    if (range.end > 0 && video.currentTime >= range.end) {
      video.currentTime = range.start;
      setCurrentTime(range.start);
      return;
    }
    setCurrentTime(video.currentTime);
  }

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      // Starting from outside the span would preview a part that is about to be
      // thrown away — drop the playhead on the kept start first.
      if (video.currentTime < range.start || video.currentTime >= range.end) {
        video.currentTime = range.start;
      }
      void video.play();
    } else {
      video.pause();
    }
  }

  // ---- Timeline dragging ---------------------------------------------------
  //
  // All pointer work is handled on the track so a drag keeps working when the
  // pointer leaves a thin handle. Capture goes on the track for the same reason.

  function timeAt(clientX: number): number {
    const track = trackRef.current;
    if (!track || duration <= 0) return 0;
    const rect = track.getBoundingClientRect();
    const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    return Math.min(duration, Math.max(0, ratio * duration));
  }

  function onTrackPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (duration <= 0 || exporting) return;
    const handle = (event.target as HTMLElement).dataset?.handle;
    const target = handle === "start" || handle === "end" ? handle : "seek";
    if (target === "seek") {
      const video = videoRef.current;
      const time = timeAt(event.clientX);
      if (video) {
        video.currentTime = time;
        setCurrentTime(time);
      }
    }
    try {
      trackRef.current?.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic pointer id we cannot capture must not cost the drag.
    }
    dragRef.current = { pointerId: event.pointerId, target };
  }

  function onTrackPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || duration <= 0) return;
    const time = timeAt(event.clientX);
    setRange((current) => {
      if (drag.target === "start") {
        return { start: Math.min(Math.max(0, time), current.end - minLength), end: current.end };
      }
      if (drag.target === "end") {
        return { start: current.start, end: Math.max(Math.min(duration, time), current.start + minLength) };
      }
      return current;
    });
  }

  function onTrackPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  }

  /** Arrow keys nudge a handle by a second — the keyboard equivalent of a drag. */
  function onHandleKeyDown(event: React.KeyboardEvent<HTMLDivElement>, which: "start" | "end") {
    if (duration <= 0) return;
    const step = event.shiftKey ? 5 : 1;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const delta = event.key === "ArrowLeft" ? -step : step;
      setRange((current) =>
        clampTrimRange(
          which === "start"
            ? { start: current.start + delta, end: current.end }
            : { start: current.start, end: current.end + delta },
          duration
        )
      );
    }
  }

  function resetRange() {
    setRange({ start: 0, end: duration });
  }

  // ---- The re-encode -------------------------------------------------------

  async function handleExport() {
    const previewUrl = objectUrl;
    if (!previewUrl || exporting || duration <= 0) return;

    const mime = pickTrimMimeType((type) => window.MediaRecorder.isTypeSupported(type));
    if (!mime) {
      setError(
        "This browser cannot re-encode the cut. You can still upload the full video below."
      );
      return;
    }

    const from = range.start;
    const to = clampTrimRange(range, duration).end;
    if (to - from < MIN_TRIM_SECONDS) {
      setError("Select at least one second to keep.");
      return;
    }

    setExporting(true);
    setError(null);
    setProgress(0);
    cancelRef.current = false;

    // An off-screen, muted-but-audible element we fully own for this job — the
    // on-screen preview must stay free to keep looping.
    const el = document.createElement("video");
    el.src = previewUrl;
    el.playsInline = true;
    el.preload = "auto";
    el.setAttribute("playsinline", "");
    el.style.cssText = "position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;";

    let stream: MediaStream | null = null;
    let recorder: MediaRecorder | null = null;
    let audioContext: AudioContext | null = null;
    let raf = 0;

    const cleanup = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      try {
        if (recorder && recorder.state !== "inactive") recorder.stop();
      } catch {
        /* already stopped */
      }
      stream?.getTracks().forEach((track) => track.stop());
      void audioContext?.close().catch(() => {});
      el.pause();
      el.removeAttribute("src");
      el.remove();
    };

    try {
      document.body.appendChild(el);

      // Wait for at least the metadata so the canvas knows the frame size.
      await new Promise<void>((resolve, reject) => {
        el.onloadedmetadata = () => resolve();
        el.onerror = () => reject(new Error("load"));
        if (el.readyState >= 1) resolve();
      });

      const size = exportCanvasSize(el.videoWidth, el.videoHeight);
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas");
      ctx.drawImage(el, 0, 0, canvas.width, canvas.height);

      stream = canvas.captureStream(30);

      // Capture the original audio alongside the re-drawn picture. Routing the
      // element through the graph also means nothing is played out loud while
      // it records. A video without an audio track, or a browser that refuses
      // the graph, still records — silent, not broken.
      try {
        audioContext = new window.AudioContext();
        const source = audioContext.createMediaElementSource(el);
        const destination = audioContext.createMediaStreamDestination();
        source.connect(destination);
        destination.stream.getAudioTracks().forEach((track) => stream!.addTrack(track));
        await audioContext.resume();
      } catch {
        audioContext = null;
      }

      recorder = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: recordingBitsPerSecond(size.height),
      });
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      const stopped = new Promise<void>((resolve) => {
        recorder!.onstop = () => resolve();
      });

      // Seek to the first kept frame before recording starts, so the file does
      // not open on a frame the creator chose to cut. A seek to where the
      // playhead already sits fires no `seeked` event at all, so that case — and
      // a seek the browser silently drops — resolves on their own rather than
      // hanging the export forever.
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        el.onseeked = finish;
        if (Math.abs(el.currentTime - from) < 0.05) {
          finish();
          return;
        }
        el.currentTime = from;
        setTimeout(finish, 1500);
      });

      recorder.start(1000);
      await el.play();

      await new Promise<void>((resolve) => {
        const tick = () => {
          if (cancelRef.current) {
            resolve();
            return;
          }
          if (el.paused || el.ended || el.currentTime >= to) {
            resolve();
            return;
          }
          ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
          const elapsed = Math.max(0, el.currentTime - from);
          const percent = Math.min(100, Math.round((elapsed / (to - from)) * 100));
          setProgress((current) => (current === percent ? current : percent));
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      });

      el.pause();
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        /* already stopped */
      }
      await stopped;

      if (cancelRef.current) {
        cleanup();
        setExporting(false);
        setProgress(0);
        return;
      }

      const type = baseMimeType(mime);
      const blob = new Blob(chunks, { type });
      if (blob.size === 0) throw new Error("empty");

      cleanup();
      setExporting(false);
      onConfirm(new File([blob], outputFileName(file.name, mime), { type }), true);
    } catch {
      cleanup();
      setExporting(false);
      if (!cancelRef.current) {
        setError("Something went wrong while cutting the video. You can upload the full video instead.");
      }
      cancelRef.current = false;
    }
  }

  function cancelExport() {
    cancelRef.current = true;
    setExporting(false);
    setProgress(0);
  }

  const startPct = duration > 0 ? (range.start / duration) * 100 : 0;
  const endPct = duration > 0 ? (range.end / duration) * 100 : 100;
  const playPct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label="Cut your video and preview it"
    >
      <div className="glass-card w-full max-w-lg p-5 animate-slide-up">
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 className="text-lg font-display font-bold flex items-center gap-2">
            <Scissors className="w-5 h-5 text-brand-400" />
            Cut & preview
          </h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={exporting}
            aria-label="Close"
            className="p-1 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-white/45 mb-4">
          Pick the part worth keeping and watch it here. Only that part is
          uploaded — the rest never leaves your phone.
        </p>

        {loadError ? (
          <p className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
            That file could not be opened as a video. Try another one.
          </p>
        ) : (
          <>
            <div className="relative rounded-2xl overflow-hidden bg-black border border-white/10">
              {!objectUrl && (
                <div className="flex items-center justify-center h-56">
                  <Loader2 className="w-6 h-6 animate-spin text-white/60" />
                </div>
              )}
              {objectUrl && (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video
                  ref={videoRef}
                  src={objectUrl}
                  playsInline
                  onLoadedMetadata={handleLoadedMetadata}
                  onTimeUpdate={handleTimeUpdate}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onError={() => setLoadError(true)}
                  className="w-full max-h-[42vh] object-contain bg-black"
                />
              )}
              {objectUrl && (
                <button
                  type="button"
                  onClick={togglePlay}
                  aria-label={playing ? "Pause preview" : "Play preview"}
                  className="absolute inset-0 flex items-center justify-center group"
                >
                  <span className="flex items-center justify-center w-14 h-14 rounded-full bg-black/55 backdrop-blur-sm text-white opacity-90 group-hover:opacity-100 transition">
                    {playing ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6 ml-0.5" />}
                  </span>
                </button>
              )}
            </div>

            {/* Timeline */}
            <div className="mt-4">
              <div
                ref={trackRef}
                onPointerDown={onTrackPointerDown}
                onPointerMove={onTrackPointerMove}
                onPointerUp={onTrackPointerUp}
                onPointerCancel={onTrackPointerUp}
                className="relative h-9 select-none touch-none cursor-pointer"
              >
                <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-2 rounded-full bg-white/15" />
                <div
                  className="absolute top-1/2 -translate-y-1/2 h-2 rounded-full bg-brand-500"
                  style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
                />
                {/* Playhead */}
                <div
                  className="absolute top-1 -bottom-1 w-0.5 bg-white/90 pointer-events-none"
                  style={{ left: `${playPct}%` }}
                />
                {/* Start handle */}
                <div
                  role="slider"
                  tabIndex={0}
                  aria-label="Clip start"
                  aria-valuemin={0}
                  aria-valuemax={Math.round(duration)}
                  aria-valuenow={Math.round(range.start)}
                  data-handle="start"
                  onKeyDown={(event) => onHandleKeyDown(event, "start")}
                  className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-9 rounded-md bg-brand-500 border-2 border-white shadow cursor-ew-resize flex items-center justify-center outline-none focus:ring-2 focus:ring-white/70"
                  style={{ left: `${startPct}%` }}
                >
                  <span className="w-0.5 h-4 bg-white/80 rounded-full" />
                </div>
                {/* End handle */}
                <div
                  role="slider"
                  tabIndex={0}
                  aria-label="Clip end"
                  aria-valuemin={0}
                  aria-valuemax={Math.round(duration)}
                  aria-valuenow={Math.round(range.end)}
                  data-handle="end"
                  onKeyDown={(event) => onHandleKeyDown(event, "end")}
                  className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-9 rounded-md bg-brand-500 border-2 border-white shadow cursor-ew-resize flex items-center justify-center outline-none focus:ring-2 focus:ring-white/70"
                  style={{ left: `${endPct}%` }}
                >
                  <span className="w-0.5 h-4 bg-white/80 rounded-full" />
                </div>
              </div>

              <div className="flex items-center justify-between mt-2 text-xs text-white/60">
                <span>{formatTimecode(range.start)}</span>
                <span className="text-white/80 font-medium">
                  Keeping {formatTimecode(kept)}
                  {duration > 0 ? ` of ${formatTimecode(duration)}` : ""}
                </span>
                <span>{formatTimecode(range.end)}</span>
              </div>

              {!fullRange && (
                <button
                  type="button"
                  onClick={resetRange}
                  className="text-xs text-white/50 hover:text-white transition mt-1"
                >
                  Reset to full video
                </button>
              )}
            </div>

            {canTrim === false && (
              <p className="mt-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                This browser cannot cut video, so the full file will be uploaded. You
                can still watch it above before sending.
              </p>
            )}

            {error && (
              <p className="mt-4 flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                {error}
              </p>
            )}

            {exporting && (
              <div className="mt-4">
                <div className="bg-surface-300/40 rounded-full h-2 overflow-hidden">
                  <div
                    className="bg-brand-500 h-full transition-all duration-200"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="text-xs text-white/50 mt-1 text-center">
                  Cutting and previewing… {progress}%. This plays the clip through,
                  so it takes about as long as the part you kept.
                </p>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-3 mt-5">
              {exporting ? (
                <>
                  <button type="button" onClick={cancelExport} className="btn-ghost flex-1">
                    Cancel cut
                  </button>
                  <button type="button" disabled className="btn-brand flex-1 flex items-center justify-center gap-2 opacity-60">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Cutting…
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => onConfirm(file, false)}
                    disabled={duration <= 0}
                    className="btn-ghost flex-1 disabled:opacity-40"
                  >
                    Upload full video
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleExport()}
                    disabled={fullRange || duration <= 0 || canTrim !== true || kept < MIN_TRIM_SECONDS}
                    className="btn-brand flex-1 flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Check className="w-4 h-4" />
                    {fullRange ? "Drag to cut" : `Upload cut (${formatTimecode(kept)})`}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
