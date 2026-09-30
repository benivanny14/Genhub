// =============================================================================
// GENHUB - Copying text to the clipboard
//
// `navigator.clipboard.writeText` is the right tool, but it is the only tool a
// caller can name and it refuses in two situations that are ordinary, not
// exceptional:
//
//   * No secure context. Plain HTTP — a phone on the LAN hitting the dev
//     server, for instance — has no `navigator.clipboard` at all.
//   * The document is not focused. `writeText` rejects with NotAllowedError
//     ("Document is not focused") whenever the page is not the focused window,
//     which is exactly the state a page can be in after an OS share sheet is
//     dismissed, or inside an in-app browser or an automated one.
//
// Every copy control in the app used to call `writeText` directly, so in both
// of those cases the copy silently failed and the viewer was told to select the
// link by hand. The selection-based copy that predates the async API has
// neither requirement, so it is kept as the fallback rather than the only path.
// =============================================================================

/**
 * Copy `text` to the clipboard. Returns true when it reached the clipboard.
 *
 * Never throws: the caller decides how to tell the viewer.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Not focused, or permission withheld — the selection copy below does not
      // need either.
    }
  }
  return legacyCopy(text);
}

/**
 * The pre-async copy: a temporary selection the browser copies on command.
 *
 * Visible to the layout engine on purpose — `display: none` and
 * `visibility: hidden` both make the selection empty, so the copy would take
 * nothing. It is moved off-screen instead, and the viewer's own selection is
 * restored afterwards so a copy never costs them their place in the text.
 */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined" || !document.body) return false;

  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.left = "-1000px";
  area.style.opacity = "0";

  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  document.body.appendChild(area);
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    if (previous && selection) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
  }
}
