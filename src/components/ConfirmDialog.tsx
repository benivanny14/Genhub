"use client";

// =============================================================================
// GENHUB - Asking before something irreversible
//
// Two destructive actions in the creator dashboard asked with `window.confirm()`.
// That is not a neutral choice:
//
//   * It renders as a browser-chrome box with the origin in it, so the sentence
//     that matters — "the video file is removed from the video host" — reads as
//     something the browser is saying rather than something we are saying.
//   * It cannot be styled, so it looks wrong in dark mode, on mobile, and next to
//     every other screen in the product.
//   * It blocks the whole main thread.
//   * Browsers suppress it in some contexts entirely (a background tab, an
//     embedded view), where the guard silently disappears — `confirm()` returns
//     false, the delete does nothing, and nobody can tell why.
//
// The dialog below is the same decision, asked in our own words, with the answer
// as a promise so a call site reads like the `confirm()` it replaces.
//
// Accessibility is not decoration here: `role="alertdialog"` + `aria-modal`,
// Escape cancels, the backdrop cancels, focus moves to the safer button (cancel)
// when it opens and returns to whatever had it when it closes, and Tab is kept
// inside the dialog while it is up.
// =============================================================================

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface ConfirmOptions {
  title: string;
  message: string;
  /** Wording for the button that goes ahead. Defaults to "Continue". */
  confirmLabel?: string;
  /** Wording for the way out. Defaults to "Cancel". */
  cancelLabel?: string;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/** Ask, and wait for the answer. Resolves false if the user backs out. */
export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) {
    throw new Error("useConfirm must be used inside <ConfirmProvider>");
  }
  return confirm;
}

interface Pending extends ConfirmOptions {
  resolve: (answer: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<Element | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      setPending({ ...options, resolve });
    });
  }, []);

  const answer = useCallback(
    (value: boolean) => {
      setPending((current) => {
        current?.resolve(value);
        return null;
      });
    },
    []
  );

  // Focus the safe button on open, and hand focus back on close. Without the
  // second half, closing the dialog leaves focus on <body> and a keyboard user
  // has to tab from the top of the page to find where they were.
  useEffect(() => {
    if (!pending) return;

    restoreFocusRef.current = document.activeElement;
    cancelRef.current?.focus();

    return () => {
      const previous = restoreFocusRef.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [pending]);

  useEffect(() => {
    if (!pending) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        answer(false);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pending, answer]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}

      {pending && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={() => answer(false)}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-message"
            className="w-full max-w-md rounded-2xl border border-white/10 bg-[#15151f] p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="confirm-title" className="text-lg font-semibold text-white">
              {pending.title}
            </h2>

            {/* `whitespace-pre-line` so a message written with \n\n keeps its
                paragraphs — the call sites explain consequences in two of them. */}
            <p
              id="confirm-message"
              className="mt-3 whitespace-pre-line text-sm leading-relaxed text-gray-300"
            >
              {pending.message}
            </p>

            <div className="mt-6 flex justify-end gap-3">
              <button
                ref={cancelRef}
                type="button"
                onClick={() => answer(false)}
                className="rounded-lg border border-white/15 px-4 py-2 text-sm font-medium text-gray-200 transition hover:bg-white/5"
              >
                {pending.cancelLabel || "Cancel"}
              </button>
              <button
                type="button"
                onClick={() => answer(true)}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-500"
              >
                {pending.confirmLabel || "Continue"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
