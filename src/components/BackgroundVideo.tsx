"use client";

// =============================================================================
// GENHUB - The clip behind every page
//
// The last layer in <body>: a fixed, silent, looping video at z-index -11, so
// it paints UNDER the aurora, the graph paper and the vignette, and is therefore
// seen only through them — and through every pane of glass the interface is
// built from. Nothing on the page sits above it that was not already above the
// aurora, so it changes what the glass frosts without changing a single layout.
//
// WHY IT IS A CLIENT COMPONENT
//
//   The setting lives in the database and the root layout is a server
//   component: reading it there would bake the answer into any page Next
//   decides to prerender, and an operator replacing the clip would then wait
//   for a rebuild to see it. Reading it through /api/site/status — the call the
//   price switch already makes — keeps the backdrop live and adds no second
//   request.
//
// IT IS ATMOSPHERE, NOT CONTENT, which decides every choice below:
//
//   muted, looped, playsInline   the only combination every browser will
//                                autoplay, and a backdrop that speaks would be
//                                a backdrop people close the tab over.
//   pointer-events: none         a tap meant for the page must never be
//                                swallowed by the background.
//   prefers-reduced-motion       it does not render at all. Vestibular triggers
//                                are not made acceptable by being decorative.
//   Save-Data                    it does not render either. This is a
//                                potentially-hundreds-of-megabytes file that
//                                adds nothing a person on a metered connection
//                                asked for.
// =============================================================================

import { useEffect, useState } from "react";
import { useBackgroundVideo } from "@/hooks/useSiteFlags";
import { backgroundVideoUrl } from "@/lib/background-video";

/**
 * Is the browser asking not to be moved?
 *
 * Read once on mount rather than through useSyncExternalStore: a setting that
 * changes while the page is open is vanishingly rare, and the layer is
 * decorative either way.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Would this device rather we did not spend its data? */
function saveData(): boolean {
  if (typeof navigator === "undefined") return false;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

export default function BackgroundVideo() {
  const video = useBackgroundVideo();
  const [allowed, setAllowed] = useState(false);
  const [broken, setBroken] = useState(false);
  const [painted, setPainted] = useState(false);
  const url = backgroundVideoUrl(video);

  useEffect(() => {
    setAllowed(!prefersReducedMotion() && !saveData());
  }, []);

  // Tell the document, so the aurora can stand back for the clip instead of
  // washing its violet over it. Toggled rather than derived from `:has()` so
  // the behaviour does not depend on the reader supporting it. Held back until
  // the first frame has arrived: a clip is up to 800 MB, and claiming the page
  // for something that is still downloading dims every pane of glass for as
  // long as that takes, on a file that may never arrive at all.
  useEffect(() => {
    const root = document.documentElement;
    if (!url || !allowed || !painted || broken) {
      root.classList.remove("gh-has-bgvideo");
      return;
    }
    root.classList.add("gh-has-bgvideo");
    return () => root.classList.remove("gh-has-bgvideo");
  }, [url, allowed, painted, broken]);

  // A replacement is a different URL and starts from nothing again.
  useEffect(() => {
    setBroken(false);
    setPainted(false);
  }, [url]);

  if (!url || !allowed || broken) return null;

  return (
    <div aria-hidden className="gh-bgvideo">
      <video
        className="gh-bgvideo-clip"
        src={url}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        disablePictureInPicture
        tabIndex={-1}
        onLoadedData={() => setPainted(true)}
        onCanPlay={() => setPainted(true)}
        onError={() => setBroken(true)}
      />
    </div>
  );
}
