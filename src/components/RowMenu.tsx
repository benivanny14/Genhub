"use client";

// =============================================================================
// GENHUB - A row's action menu, rendered on top of everything
//
// These menus used to be absolutely positioned inside the card that owns the
// row. That works right up until the card has a neighbour: every `.glass-card`
// carries `backdrop-blur`, and a backdrop filter opens a stacking context, so
// the card below a row painted over a menu that had spilled out of the card
// above it. The bottom row of "My Videos" opened Edit / Publish / Delete
// underneath the "Video Performance" table — the menu looked broken. Raising
// the card's `z-index` fixed the sibling in Chrome but not everywhere: Safari
// has long mis-stacked composited `-webkit-backdrop-filter` layers, which is
// exactly the browser a phone-first audience uses.
//
// So the panel no longer lives inside the layout it was fighting. It is
// portalled into `document.body`, positioned with `position: fixed` from the
// trigger's own rectangle, and given a viewport-level z-index. Nothing in a
// card — clipping, blur, transform, a future wrapper — can reach it, and the
// final row flips the menu upward when there is no room below.
//
// The trigger stays exactly where it is, so the row keeps its layout and the
// button keeps its `aria-expanded` state.
// =============================================================================

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Matches `min-w-[180px]` on the panel; also the fallback before measuring. */
const MENU_MIN_WIDTH = 180;
/** Keeps the panel off the edges of the screen. */
const VIEWPORT_MARGIN = 8;
/** Fallback height (5 rows + padding) for the first placement pass. */
const ESTIMATED_HEIGHT = 176;

/** `useLayoutEffect` warns during SSR; the panel only exists after a click. */
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

interface RowMenuProps {
  /** Identifies this menu to the page, which tracks the one open menu. */
  id: string;
  open: boolean;
  /** Called with `null` to close, so the page keeps its single-open-menu rule. */
  onOpenChange: (id: string | null) => void;
  /** Accessible name for the trigger button. */
  label: string;
  /** Trigger contents — usually the three-dot icon, or a spinner while busy. */
  icon: ReactNode;
  disabled?: boolean;
  /** The menu items. */
  children: ReactNode;
}

export default function RowMenu({
  id,
  open,
  onOpenChange,
  label,
  icon,
  disabled,
  children,
}: RowMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  // Follow the trigger: it moves when the page scrolls, the window resizes, or
  // a row above this one changes height. Closing on scroll instead would make
  // the menu a trap for anyone who scrolls with a thumb.
  useIsoLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.max(panelRef.current?.offsetWidth ?? MENU_MIN_WIDTH, MENU_MIN_WIDTH);
      const height = panelRef.current?.offsetHeight ?? ESTIMATED_HEIGHT;

      const roomBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
      // Open upward only when below is genuinely tighter than above.
      const flipUp = roomBelow < height && rect.top - VIEWPORT_MARGIN > roomBelow;
      const top = flipUp ? rect.top - height - VIEWPORT_MARGIN : rect.bottom + VIEWPORT_MARGIN;

      const left = Math.min(
        Math.max(VIEWPORT_MARGIN, rect.right - width),
        Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
      );
      const next = { top: Math.max(VIEWPORT_MARGIN, top), left };
      // Identical coordinates must not re-render: this runs on every scroll
      // frame while the menu is open.
      setPosition((prev) =>
        prev && prev.top === next.top && prev.left === next.left ? prev : next
      );
    };

    place();
    window.addEventListener("resize", place);
    // Capture phase: an inner scroll container fires the event without it
    // reaching the window otherwise.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // Dismissal. `mousedown` rather than `click` so the menu is gone before the
  // element underneath receives the press.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onOpenChange(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onOpenChange(null);
      triggerRef.current?.focus();
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange]);

  const panel =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={panelRef}
            role="menu"
            aria-label={label}
            style={
              position
                ? { top: position.top, left: position.left }
                : // Hidden for the one layout pass it takes to measure, so the
                  // panel never paints at the top-left corner first.
                  { top: 0, left: 0, visibility: "hidden" }
            }
            className="fixed z-40 min-w-[180px] rounded-xl border border-white/10 bg-surface-200 py-1 shadow-xl"
          >
            {children}
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        ref={triggerRef}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(open ? null : id)}
        disabled={disabled}
        className="p-2 rounded-lg hover:bg-white/10 transition disabled:opacity-50"
      >
        {icon}
      </button>
      {panel}
    </div>
  );
}
