"use client";

// =============================================================================
// GENHUB - Crop a picture before it is uploaded
// =============================================================================
// Choosing a file and sending it straight up meant the site decided the framing:
// a portrait photo became whatever the middle of the file happened to be, and
// the only way to fix it was to edit the picture somewhere else and come back.
// Every app that shows a picture in a fixed shape lets you move it first. This
// is that step, and it is shared, so the profile picture and a video cover crop
// the same way.
//
// The maths is one transform. The picture is laid out at `scale` (image pixels
// per viewport pixel) inside a fixed viewport, moved by (ox, oy) from the
// centre, and clamped so the frame can never show an empty edge. The preview is
// plain CSS of exactly that layout; the saved file is the same transform drawn
// on a canvas at output resolution. Nothing else is involved, so what the
// viewport shows is what the file contains.
//
// `shape` is the one thing the two callers disagree about: an avatar is a
// square and a cover is 16:9.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Move, X, ZoomIn } from "lucide-react";
import { HEIF_NOT_DECODABLE_MESSAGE, isHeifContainer } from "@/lib/image-bytes";

export type CropShape = "square" | "wide";

interface ImageCropperProps {
  /** The file the user just picked. */
  file: File;
  shape?: CropShape;
  /** Shown on the confirm button, e.g. "Save picture". */
  confirmLabel?: string;
  /** True while the cropped file is being uploaded. */
  busy?: boolean;
  onCancel: () => void;
  /** Receives the cropped picture as a new File, ready to upload. */
  onConfirm: (cropped: File) => void;
}

/** How much of the picture must be inside the frame at its widest (1 = cover). */
const MAX_ZOOM = 4;

/**
 * The sentence for everything that is not a HEIF container — a truncated file, a
 * .jpg that is really something else, a picture the phone could not hand over in
 * full. It stays because it is still true, and it is no longer the only answer.
 */
const CANNOT_OPEN_IMAGE = "That file could not be opened as an image. Try another one.";

const LAYOUTS: Record<CropShape, { viewportW: number; viewportH: number; outW: number; outH: number }> = {
  square: { viewportW: 288, viewportH: 288, outW: 512, outH: 512 },
  wide: { viewportW: 320, viewportH: 180, outW: 1280, outH: 720 },
};

interface Layout {
  /** Viewport (image pixels per viewport pixel, plus the offset from centre). */
  scale: number;
  ox: number;
  oy: number;
}

export default function ImageCropper({
  file,
  shape = "square",
  confirmLabel = "Save",
  busy = false,
  onCancel,
  onConfirm,
}: ImageCropperProps) {
  const { viewportW, viewportH, outW, outH } = LAYOUTS[shape];

  const [image, setImage] = useState<HTMLImageElement | null>(null);
  //
  // A MESSAGE, not a flag. "That file could not be opened as an image" was the
  // only thing this could ever say, and for the case it actually happens in — a
  // HEIC photo, which is what an iPhone and many Android cameras save, and which
  // no browser except Safari can decode — that sentence is a dead end. The file
  // is fine; the browser is the limit. Naming the format is what turns it into a
  // detour: the creator takes the picture with the camera instead.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [working, setWorking] = useState(false);

  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // The object URL is created and revoked by the SAME effect, which is the part
  // that matters: an effect that only revokes (paired with a memoised URL) hands
  // the second mount of a double-invoked effect a URL that the first cleanup
  // already revoked, and the preview becomes "that file could not be opened as
  // an image" with nothing wrong with the file.
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  /**
   * What to say when this browser will not open the picture.
   *
   * The bytes decide, not the filename: a HEIC saved under a `.jpg` name by a
   * gallery or a chat app is the same file and fails the same way, and the
   * filename is exactly the part that is wrong. `isHeifContainer` is the same
   * read the upload route uses, so the client and the server cannot disagree
   * about what a picture is.
   */
  async function explainFailure() {
    let undecodable = false;
    try {
      const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
      undecodable = isHeifContainer(head);
    } catch {
      // Could not even read the header — fall through to the generic sentence.
    }
    setLoadError(undecodable ? HEIF_NOT_DECODABLE_MESSAGE : CANNOT_OPEN_IMAGE);
  }

  useEffect(() => {
    if (!objectUrl) return;
    // `cancelled` guards the answer, not the request: a slow failure from a
    // picture the creator already moved on from must not overwrite the picture
    // they are looking at now.
    let cancelled = false;
    setImage(null);
    setLoadError(null);
    const img = new window.Image();
    img.onload = () => {
      if (!cancelled) setImage(img);
    };
    img.onerror = () => {
      if (!cancelled) void explainFailure();
    };
    img.src = objectUrl;
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectUrl, file]);

  // Escape closes the dialog — a modal with no keyboard way out is a trap.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  /** The scale that makes the picture exactly cover the frame at zoom 1. */
  const coverScale = useCallback(
    (img: HTMLImageElement | null) => {
      if (!img) return 1;
      return Math.max(viewportW / img.naturalWidth, viewportH / img.naturalHeight);
    },
    [viewportW, viewportH]
  );

  const scale = useMemo(() => {
    if (!image) return 1;
    return coverScale(image) * zoom;
  }, [image, zoom, coverScale]);

  /** Keep the frame full: the picture may never be dragged off an edge. */
  const clamp = useCallback(
    (next: { x: number; y: number }, scaleInUse: number) => {
      if (!image) return { x: 0, y: 0 };
      const maxX = Math.max(0, (image.naturalWidth * scaleInUse - viewportW) / 2);
      const maxY = Math.max(0, (image.naturalHeight * scaleInUse - viewportH) / 2);
      return {
        x: Math.min(maxX, Math.max(-maxX, next.x)),
        y: Math.min(maxY, Math.max(-maxY, next.y)),
      };
    },
    [image, viewportW, viewportH]
  );

  // Zooming out can leave the old offset outside the new limits.
  useEffect(() => {
    setOffset((current) => clamp(current, scale));
  }, [scale, clamp]);

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!image) return;
    // Capture keeps the drag alive when the pointer leaves the frame, but it
    // throws for a pointer id the browser does not know (a synthetic or
    // assistive-tech event) — that must not cost the user the drag itself.
    try {
      (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    } catch {}
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
    };
    setDragging(true);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setOffset(
      clamp(
        {
          x: drag.originX + (event.clientX - drag.startX),
          y: drag.originY + (event.clientY - drag.startY),
        },
        scale
      )
    );
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      setDragging(false);
    }
  }

  /** Draw exactly what the viewport shows, at output resolution. */
  function render(): Promise<Blob | null> {
    return new Promise((resolve) => {
      if (!image) return resolve(null);
      const canvas = document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(null);

      // Viewport pixels -> output pixels.
      const k = outW / viewportW;
      const drawScale = scale * k;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      // Draw the picture centred on its natural middle, moved to the offset the
      // user chose — not to where they dragged the picture's top-left corner.
      const centreX = outW / 2 + offset.x * k;
      const centreY = outH / 2 + offset.y * k;
      ctx.translate(centreX, centreY);
      ctx.scale(drawScale, drawScale);
      ctx.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);

      canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.92);
    });
  }

  async function handleConfirm() {
    setWorking(true);
    try {
      const blob = await render();
      if (!blob) {
        setWorking(false);
        return;
      }
      const name = file.name.replace(/\.[^.]+$/, "") || "picture";
      onConfirm(new File([blob], `${name}.jpg`, { type: "image/jpeg" }));
    } finally {
      setWorking(false);
    }
  }

  const disabled = !image || busy || working;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Move and zoom your picture"
    >
      <div className="glass-card w-full max-w-md p-5 animate-slide-up">
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 className="text-lg font-display font-bold">Choose the framing</h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="p-1 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-white/45 mb-4">
          Drag the picture to move it, and use the slider to zoom. The{" "}
          {shape === "square" ? "square" : "frame"} is exactly what will be
          saved.
        </p>

        {loadError ? (
          <div className="space-y-3">
            <p className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
              {loadError}
            </p>
            {/*
              The way through, and the reason this is not just an error box.

              A picture this browser cannot decode is still the creator's
              picture, and refusing it by format meant telling them to choose an
              image while they were looking at the image they had chosen. So the
              framing step is what gets skipped — never the file: the original
              bytes are handed to the caller exactly as they came off the phone,
              and it becomes the cover without ever being re-encoded here.

              What that costs is said out loud rather than implied: the crop did
              not happen, so the picture is shown in whatever shape it is, and a
              format no browser can draw (a HEIC, on a machine without the
              codec) will look broken wherever it is displayed.
            */}
            <button
              type="button"
              onClick={() => onConfirm(file)}
              disabled={busy}
              className="btn-ghost w-full disabled:opacity-50"
            >
              Tumia picha hii kama ilivyo — use this picture as it is
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="w-full text-xs text-white/50 underline underline-offset-2 hover:text-white/80 transition"
            >
              Or choose a different picture
            </button>
          </div>
        ) : (
          <>
            <div
              className={`relative mx-auto overflow-hidden rounded-2xl border border-white/10 bg-black touch-none select-none ${
                dragging ? "cursor-grabbing" : "cursor-move"
              }`}
              style={{ width: viewportW, height: viewportH }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              {!image && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <Loader2 className="w-6 h-6 animate-spin text-white/60" />
                </div>
              )}
              {image && objectUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={objectUrl}
                  alt=""
                  draggable={false}
                  className="absolute pointer-events-none max-w-none"
                  style={{
                    width: image.naturalWidth * scale,
                    height: image.naturalHeight * scale,
                    left: viewportW / 2 + offset.x - (image.naturalWidth * scale) / 2,
                    top: viewportH / 2 + offset.y - (image.naturalHeight * scale) / 2,
                  }}
                />
              )}

              {/* Rule-of-thirds guides — the only framing help a plain frame has. */}
              <div className="pointer-events-none absolute inset-0 opacity-30">
                <div className="absolute left-1/3 top-0 bottom-0 w-px bg-white/40" />
                <div className="absolute left-2/3 top-0 bottom-0 w-px bg-white/40" />
                <div className="absolute top-1/3 left-0 right-0 h-px bg-white/40" />
                <div className="absolute top-2/3 left-0 right-0 h-px bg-white/40" />
              </div>
            </div>

            <div className="flex items-center gap-3 mt-4">
              <Move className="w-4 h-4 text-white/40 shrink-0" />
              <input
                type="range"
                min={1}
                max={MAX_ZOOM}
                step={0.01}
                value={zoom}
                onChange={(e) => setZoom(parseFloat(e.target.value))}
                aria-label="Zoom"
                className="flex-1 h-1 bg-white/20 rounded-full appearance-none cursor-pointer
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4
                  [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand-500
                  [&::-webkit-slider-thumb]:hover:scale-110 [&::-webkit-slider-thumb]:transition-transform"
              />
              <ZoomIn className="w-4 h-4 text-white/40 shrink-0" />
              <button
                type="button"
                onClick={() => {
                  setZoom(1);
                  setOffset({ x: 0, y: 0 });
                }}
                className="text-xs text-white/50 hover:text-white transition shrink-0"
              >
                Reset
              </button>
            </div>
          </>
        )}

        <div className="flex gap-3 mt-5">
          <button type="button" onClick={onCancel} className="btn-ghost flex-1">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={disabled}
            className="btn-brand flex-1 flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {busy || working ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Check className="w-4 h-4" />
            )}
            {busy ? "Uploading..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
