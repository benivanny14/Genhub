"use client";

import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { CheckCircle, XCircle, AlertTriangle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

// =============================================================================
// Toast Context
// =============================================================================

/** What a caller may change on a toast that is already on screen. */
interface ToastPatch {
  type?: Toast["type"];
  message?: string;
  /** Milliseconds before it disappears. 0 = stays until it is updated away. */
  duration?: number;
  /** 0..100; renders a bar under the message. `undefined` removes it. */
  progress?: number;
}

interface Toast {
  id: string;
  type: "success" | "error" | "warning" | "info";
  message: string;
  /** 0 = sticky: no timer, the caller decides when it goes. */
  duration?: number;
  progress?: number;
}

interface ToastContextType {
  /** Returns the toast's id, so a long job can update it as it progresses. */
  toast: (type: Toast["type"], message: string, duration?: number) => string;
  success: (message: string) => string;
  error: (message: string) => string;
  warning: (message: string) => string;
  info: (message: string) => string;
  /**
   * Change a toast already on screen.
   *
   * This is what makes a progress toast possible without another component:
   * one toast is created sticky, its message and bar are rewritten as the work
   * advances, and it is finished off with a real `duration` so it dismisses
   * itself once the work is done. See the video upload for the caller.
   */
  update: (id: string, patch: ToastPatch) => void;
  /** Take a toast down immediately (a sticky one that was superseded). */
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export function useToast(): ToastContextType {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

// =============================================================================
// Toast Provider
// =============================================================================

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback(
    (type: Toast["type"], message: string, duration = 4000) => {
      const id = Math.random().toString(36).slice(2);
      // A sticky toast (`duration: 0`) is stored with no duration at all: the
      // ToastItem only sets a timer for a positive number, so 0 means "no
      // timer" rather than "remove in zero seconds".
      setToasts((prev) => [
        ...prev,
        duration > 0 ? { id, type, message, duration } : { id, type, message },
      ]);
      return id;
    },
    []
  );

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const updateToast = useCallback((id: string, patch: ToastPatch) => {
    setToasts((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        const next: Toast = { ...t, ...patch };
        // `duration: 0` means "stop being sticky" is never what a caller means;
        // it means the opposite. Dropping the key keeps the timer off.
        if (patch.duration !== undefined && patch.duration <= 0) delete next.duration;
        return next;
      })
    );
  }, []);

  const contextValue: ToastContextType = {
    toast: addToast,
    success: (msg) => addToast("success", msg),
    error: (msg) => addToast("error", msg),
    warning: (msg) => addToast("warning", msg),
    info: (msg) => addToast("info", msg),
    update: updateToast,
    dismiss: removeToast,
  };

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      {/* Toast container */}
      <div className="fixed bottom-4 right-4 z-[9999] flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2.5 pointer-events-none">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onRemove={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// =============================================================================
// Toast Item
// =============================================================================

/**
 * One entry per kind of message, and every field in here differs per kind.
 *
 * A toast that only changes colour is read as one message with four tints, so
 * these four deliberately disagree about more than hue: a success arrives with
 * a spring upward and a round icon, a refusal lands with a shake and squared
 * corners, a warning slides in from the side, and a notice fades up quietly.
 * A reader who cannot separate the colours still cannot confuse the four.
 *
 * The words in here are the ONLY thing that changes: the provider's API, the
 * sticky/progress behaviour and the dismissal timer all stay as they were, so
 * the ~260 existing `toast(...)` call sites are untouched by this file.
 */
interface ToastVariant {
  Icon: typeof Info;
  /** The short label above the message — the fastest read on the card. */
  title: string;
  /** Card surface, including its corner radius. */
  shell: string;
  /** The tinted wash inside the card. */
  wash: string;
  /** The colour bar down the left edge. */
  rail: string;
  /** The tile the icon sits in, including its shape. */
  tile: string;
  /** The title's colour. */
  heading: string;
  /** The bar under a progress toast. */
  bar: string;
  /** The dismiss button's hover colour. */
  close: string;
  /** How this kind arrives. Four different motions, not one. */
  motion: string;
  /** Errors interrupt a screen reader; the rest wait their turn. */
  role: "status" | "alert";
}

const VARIANTS: Record<Toast["type"], ToastVariant> = {
  success: {
    Icon: CheckCircle,
    title: "Success",
    shell: "rounded-2xl border-emerald-400/35 bg-surface-400/95 shadow-xl shadow-emerald-500/25",
    wash: "bg-gradient-to-br from-emerald-500/25 via-transparent to-transparent",
    rail: "w-1.5 bg-gradient-to-b from-emerald-300 via-emerald-400 to-emerald-600",
    tile: "rounded-full bg-emerald-400/15 text-emerald-300 ring-emerald-400/30",
    heading: "text-emerald-300",
    bar: "bg-gradient-to-r from-emerald-300 to-emerald-500",
    close: "hover:text-emerald-200",
    motion: "animate-toast-success",
    role: "status",
  },
  error: {
    Icon: XCircle,
    title: "Error",
    shell: "rounded-lg border-red-400/40 bg-surface-400/95 shadow-xl shadow-red-500/25",
    wash: "bg-gradient-to-tr from-red-600/30 via-transparent to-transparent",
    rail: "w-1.5 bg-gradient-to-b from-red-300 via-red-500 to-red-700",
    tile: "rounded-md bg-red-500/20 text-red-300 ring-red-400/40",
    heading: "text-red-300",
    bar: "bg-gradient-to-r from-red-300 to-red-600",
    close: "hover:text-red-200",
    motion: "animate-toast-error",
    role: "alert",
  },
  warning: {
    Icon: AlertTriangle,
    title: "Warning",
    shell: "rounded-2xl border-amber-400/45 bg-surface-400/95 shadow-xl shadow-amber-500/25",
    wash: "bg-gradient-to-b from-amber-500/25 via-transparent to-transparent",
    rail: "w-2 bg-gradient-to-b from-amber-200 via-amber-400 to-amber-600",
    tile: "rounded-lg bg-amber-400/15 text-amber-300 ring-amber-400/30",
    heading: "text-amber-300",
    bar: "bg-gradient-to-r from-amber-300 to-amber-500",
    close: "hover:text-amber-200",
    motion: "animate-toast-warning",
    role: "status",
  },
  info: {
    Icon: Info,
    title: "Info",
    shell: "rounded-xl border-sky-400/30 bg-surface-400/95 shadow-xl shadow-sky-500/20",
    wash: "bg-gradient-to-bl from-sky-500/20 via-brand-500/10 to-transparent",
    rail: "w-1.5 bg-gradient-to-b from-sky-300 via-sky-400 to-brand-500",
    tile: "rounded-full bg-sky-400/15 text-sky-300 ring-sky-400/30",
    heading: "text-sky-300",
    bar: "bg-gradient-to-r from-sky-300 to-brand-400",
    close: "hover:text-sky-200",
    motion: "animate-toast-info",
    role: "status",
  },
};

function ToastItem({
  toast,
  onRemove,
}: {
  toast: Toast;
  onRemove: (id: string) => void;
}) {
  useEffect(() => {
    // No duration = sticky. A progress toast is rewritten on every chunk, and a
    // timer on each of those rewrites is how a toast disappears mid-upload.
    if (!toast.duration) return;
    const timer = setTimeout(() => onRemove(toast.id), toast.duration);
    return () => clearTimeout(timer);
  }, [toast, onRemove]);

  const variant = VARIANTS[toast.type];
  const Icon = variant.Icon;

  return (
    <div
      role={variant.role}
      className={cn(
        "pointer-events-auto relative overflow-hidden border px-4 py-3.5 pl-5 backdrop-blur-xl",
        variant.shell,
        variant.motion
      )}
    >
      {/* The colour bar and the wash are what make a glance enough. */}
      <span aria-hidden className={cn("absolute inset-y-0 left-0", variant.rail)} />
      <span aria-hidden className={cn("absolute inset-0", variant.wash)} />

      <div className="relative flex items-start gap-3">
        <span
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center ring-1",
            variant.tile
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="flex-1 min-w-0">
          <p className={cn("text-[11px] font-semibold uppercase tracking-[0.14em]", variant.heading)}>
            {variant.title}
          </p>
          <p className="mt-0.5 text-sm leading-snug break-words text-white/90">{toast.message}</p>
          {toast.progress !== undefined && (
            <div className="mt-2 h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div
                className={cn("h-full rounded-full transition-all duration-200", variant.bar)}
                style={{ width: `${Math.min(100, Math.max(0, toast.progress))}%` }}
                role="progressbar"
                aria-valuenow={Math.round(toast.progress)}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            </div>
          )}
        </div>
        <button
          onClick={() => onRemove(toast.id)}
          aria-label="Dismiss"
          className={cn("-mr-1 -mt-1 shrink-0 rounded-lg p-1 text-white/35 transition", variant.close)}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
