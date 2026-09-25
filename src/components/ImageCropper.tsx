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
  const [loadError, setLoadError] = useState(false);
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

  useEffect(() => {
    if (!objectUrl) return;
    setImage(null);
    setLoadError(false);
    const img = new window.Image();
    img.onload = () => setImage(img);
    img.onerror = () => setLoadError(true);
    img.src = objectUrl;
  }, [objectUrl]);

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
          Drag the picture to move it, and use the slider to zoom. The square is
          exactly what will be saved.
        </p>

        {loadError ? (
          <p className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
            That file could not be opened as an image. Try another one.
          </p>
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
