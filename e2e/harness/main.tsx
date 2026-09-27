// =============================================================================
// GENHUB - the page the trimmer browser test drives
//
// This is deliberately thin. It does the one thing the upload page does around
// the trimmer — hand it a File and receive the file to upload — and nothing
// else. Everything under test (loading, dragging, keyboard nudging, the cut,
// the errors) is the real component; a harness that reimplemented any of it
// would be testing itself.
//
// Two fixtures are served, chosen by `?fixture=…`: a silent clip and one with a
// soundtrack, so the same component can be asked to preserve audio.
//
// What it adds is observability: the File the component hands back cannot cross
// into the test process, so results are parked on `window.__harness` and the
// test reads size/type/name there and decodes the bytes in the page.
// =============================================================================

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import VideoTrimmer, { type VideoTrimExportPath } from "@/components/VideoTrimmer";
import "@/app/globals.css";

export interface Confirmation {
  name: string;
  type: string;
  size: number;
  /** True when the component produced the file itself; false for "upload full". */
  trimmed: boolean;
  /**
   * How the frames were produced, when the component produced them: `decoder`
   * for the demux+VideoDecoder fast path, `seek`, or `recorder`. Recorded so a
   * test can prove an H.264/MP4 source really took the fast path rather than
   * merely producing a correct file by the slow one.
   */
  path?: VideoTrimExportPath;
  file: File;
}

interface HarnessState {
  /** Name of the fixture once it has been fetched and wrapped in a File. */
  fixture: { name: string; size: number; type: string } | null;
  confirmations: Confirmation[];
  cancels: number;
  error: string | null;
}

declare global {
  interface Window {
    __harness: HarnessState;
  }
}

const DEFAULT_FIXTURE = "short.webm";

const params = new URLSearchParams(window.location.search);

const fixtureName = params.get("fixture") || DEFAULT_FIXTURE;

/** The publishing length rule, when a test asks for one (`?min=10`). */
const minDurationSeconds = Number(params.get("min") ?? 0) || 0;

const state: HarnessState = {
  fixture: null,
  confirmations: [],
  cancels: 0,
  error: null,
};
window.__harness = state;

function Harness() {
  const [file, setFile] = useState<File | null>(null);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/e2e/fixtures/${fixtureName}`)
      .then((response) => {
        if (!response.ok) throw new Error(`fixture HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        const next = new File([blob], fixtureName, {
          type: blob.type || "video/webm",
        });
        state.fixture = { name: next.name, size: next.size, type: next.type };
        setFile(next);
      })
      .catch((error: unknown) => {
        state.error = error instanceof Error ? error.message : String(error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!file) {
    return <div data-testid="loading">loading fixture…</div>;
  }

  if (closed) {
    return <div data-testid="closed">trim closed</div>;
  }

  return (
    <VideoTrimmer
      file={file}
      minDurationSeconds={minDurationSeconds}
      onCancel={() => {
        state.cancels += 1;
        setClosed(true);
      }}
      onConfirm={(chosen, trimmed, details) => {
        state.confirmations.push({
          name: chosen.name,
          type: chosen.type,
          size: chosen.size,
          trimmed,
          path: details?.path,
          file: chosen,
        });
        setClosed(true);
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
