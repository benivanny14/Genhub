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
      <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 max-w-sm w-full pointer-events-none">
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

const ICONS = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const STYLES = {
  success: "border-emerald-500/30 bg-emerald-500/10",
  error: "border-red-500/30 bg-red-500/10",
  warning: "border-amber-500/30 bg-amber-500/10",
  info: "border-blue-500/30 bg-blue-500/10",
};

const ICON_COLORS = {
  success: "text-emerald-400",
  error: "text-red-400",
  warning: "text-amber-400",
  info: "text-blue-400",
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

  const Icon = ICONS[toast.type];

  return (
    <div
      className={cn(
        "pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-xl border backdrop-blur-xl animate-slide-up shadow-xl",
        STYLES[toast.type]
      )}
    >
      <Icon className={cn("w-5 h-5 mt-0.5 shrink-0", ICON_COLORS[toast.type])} />
      <div className="flex-1 min-w-0">
        <p className="text-sm">{toast.message}</p>
        {toast.progress !== undefined && (
          <div className="mt-2 h-1 rounded-full bg-white/15 overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-200",
                toast.type === "error" ? "bg-red-400" : "bg-brand-400"
              )}
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
        className="text-white/40 hover:text-white shrink-0"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
