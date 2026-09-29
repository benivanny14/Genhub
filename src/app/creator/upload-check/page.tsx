"use client";

// =============================================================================
// GENHUB - "Pima mtandao" / Network check
//
// The page a creator is sent to when an upload fails and nobody can say why. It
// runs the SAME two requests an upload makes — a signed write of one object and a
// signed write of one PART — from the device that is failing, and prints what
// happened to each, because that is the only place the answer exists: a browser
// tells the page nothing about why a cross-origin request failed, and the server
// never sees the request at all.
//
// It is a page rather than a log line because the failing device is a phone the
// person is holding, and "open this on the phone and tell me what it says" is the
// only debugging step available that does not require them to reproduce a
// two-gigabyte upload. See lib/upload-diagnostics.ts for what each probe means.
// =============================================================================

import { useState } from "react";
import Link from "next/link";
import Header from "@/components/Header";
import {
  describeProbePair,
  hostOf,
  probeReachability,
  probeWrite,
  type ReachabilityProbe,
  type WriteProbe,
} from "@/lib/upload-diagnostics";

type Tone = "ok" | "fail" | "skipped";

interface Line {
  label: string;
  detail: string;
  tone: Tone;
}

const TONE_CLASS: Record<Tone, string> = {
  ok: "text-emerald-300",
  fail: "text-red-300",
  skipped: "text-white/40",
};

export default function UploadCheckPage() {
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [device, setDevice] = useState<string>("");

  async function run() {
    setRunning(true);
    setLines([]);

    // What the phone says about itself. Only Chrome knows these, and they are
    // what turned an hour of guessing into a sentence: "3g, 0.4 Mbps down, 750 ms
    // rtt" is a different problem from "4g, 20 Mbps".
    const connection = (navigator as unknown as { connection?: { effectiveType?: string; downlink?: number; rtt?: number } })
      .connection;
    setDevice(
      [
        `online: ${navigator.onLine}`,
        connection?.effectiveType ? `type: ${connection.effectiveType}` : null,
        typeof connection?.downlink === "number" ? `downlink: ${connection.downlink} Mbps` : null,
        typeof connection?.rtt === "number" ? `rtt: ${connection.rtt} ms` : null,
        `user agent: ${navigator.userAgent}`,
      ]
        .filter(Boolean)
        .join(" · ")
    );

    const found: Line[] = [];

    // 1. Our own server, as the control. If this fails, nothing else can be
    //    trusted: the page itself is not talking to Genhub.
    let controlOk = false;
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      controlOk = res.ok;
      found.push({
        label: "Genhub itself",
        detail: `HTTP ${res.status}`,
        tone: res.ok ? "ok" : "fail",
      });
    } catch (error) {
      found.push({
        label: "Genhub itself",
        detail: error instanceof Error ? error.name : "failed",
        tone: "fail",
      });
    }
    setLines([...found]);

    // 2. Two signed URLs, so the checks below are the real thing rather than a
    //    rehearsal: a browser cannot fake a preflight, so the request has to be
    //    one an upload would actually make.
    let whole: { url: string; key: string } | null = null;
    let part: { url: string; key: string; uploadId: string; partNumber: number } | null = null;
    let id = "";
    try {
      const res = await fetch("/api/videos/upload-check", { cache: "no-store" });
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        data?: {
          wholeObject?: { url: string; key: string };
          part?: { url: string; key: string; uploadId: string; partNumber: number };
        };
      };
      if (!data.success || !data.data?.wholeObject || !data.data.part) {
        found.push({
          label: "Signed probe URLs",
          detail: data.error || "the server did not hand out a probe",
          tone: "fail",
        });
        setLines([...found]);
        setRunning(false);
        return;
      }
      whole = data.data.wholeObject;
      part = data.data.part;
      id = whole.key.replace(/^incoming\//, "");
      found.push({ label: "Signed probe URLs", detail: "both signed for this page", tone: "ok" });
    } catch (error) {
      found.push({
        label: "Signed probe URLs",
        detail: error instanceof Error ? error.name : "failed",
        tone: "fail",
      });
      setLines([...found]);
      setRunning(false);
      return;
    }
    setLines([...found]);

    // 3. Can this device reach the bucket's host at all? A no-cors request, so
    //    only the network can make it fail.
    const host = hostOf(whole.url);
    let reach: ReachabilityProbe | null = null;
    if (host) {
      reach = await probeReachability(host);
      found.push({
        label: "Reach the storage host",
        detail: reach.ok ? `yes, in ${reach.ms} ms` : `no (${reach.error ?? "?"} after ${reach.ms} ms)`,
        tone: reach.ok ? "ok" : "fail",
      });
    } else {
      found.push({ label: "Reach the storage host", detail: "the signed URL had no host", tone: "skipped" });
    }
    setLines([...found]);

    // 4. A real write of one whole object...
    const wholeProbe: WriteProbe = await probeWrite(whole.url);
    found.push({
      label: "Write one small object",
      detail: wholeProbe.ok
        ? `HTTP ${wholeProbe.status} in ${wholeProbe.ms} ms, ETag ${wholeProbe.etag ? "present" : "missing"}`
        : `refused (${wholeProbe.status ?? wholeProbe.error ?? "?"}) after ${wholeProbe.ms} ms`,
      tone: wholeProbe.ok ? "ok" : "fail",
    });
    found.push({
      label: "What that means",
      detail: describeProbePair(reach, wholeProbe, "storage host"),
      tone: wholeProbe.ok ? "ok" : "fail",
    });
    setLines([...found]);

    // 5. ...and a real write of PART ONE of a real multipart upload, which is the
    //    request that has been failing on the phone.
    const partProbe: WriteProbe = await probeWrite(part.url, 30_000);
    found.push({
      label: "Write part 1 of a multipart upload",
      detail: partProbe.ok
        ? `HTTP ${partProbe.status} in ${partProbe.ms} ms`
        : `refused (${partProbe.status ?? partProbe.error ?? "?"}) after ${partProbe.ms} ms`,
      tone: partProbe.ok ? "ok" : "fail",
    });
    found.push({
      label: "What that means",
      detail: describeProbePair(reach, partProbe, "storage host, for a part"),
      tone: partProbe.ok ? "ok" : "fail",
    });
    setLines([...found]);

    // 6. Send it back and let the server clean up after itself.
    try {
      await fetch("/api/videos/upload-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          probeId: id,
          uploadId: part.uploadId,
          reach,
          whole: { ok: wholeProbe.ok, status: wholeProbe.status, ms: wholeProbe.ms, error: wholeProbe.error },
          part: { ok: partProbe.ok, status: partProbe.status, ms: partProbe.ms, error: partProbe.error },
        }),
      });
      found.push({
        label: "Reported to Genhub",
        detail: controlOk ? "sent — support can read it" : "could not be sent",
        tone: controlOk ? "ok" : "fail",
      });
    } catch {
      found.push({ label: "Reported to Genhub", detail: "could not be sent", tone: "fail" });
    }

    setLines([...found]);
    setRunning(false);
  }

  return (
    <div className="min-h-screen bg-surface-50">
      <Header />
      <main className="max-w-2xl mx-auto px-4 py-8">
        <h1 className="text-xl font-semibold text-white">Network check</h1>
        <p className="text-sm text-white/60 mt-1">
          Pima mtandao wako kabla ya kupandisha video. Ukurasa huu unafanya maombi
          mawili halisi — kuandika faili moja ndogo, na kuandika <strong>kipande cha 1</strong> cha
          upload ya vipande — kutoka kwenye kifaa hiki, na kukuambia kila kimoja kilivyokwenda.
        </p>

        <button
          type="button"
          onClick={() => void run()}
          disabled={running}
          className="btn-brand mt-5 disabled:opacity-50"
        >
          {running ? "Inapima…" : "Anza kupima (start the check)"}
        </button>

        {device && <p className="text-xs text-white/40 mt-4 break-words">{device}</p>}

        <div className="mt-5 space-y-2">
          {lines.map((line, index) => (
            <div key={index} className="rounded-xl border border-white/10 bg-surface-300/30 p-3">
              <p className={`text-sm font-medium ${TONE_CLASS[line.tone]}`}>{line.label}</p>
              <p className="text-xs text-white/70 mt-1 break-words">{line.detail}</p>
            </div>
          ))}
        </div>

        <p className="text-xs text-white/40 mt-6">
          Ukiona kitu chekundu, tuma screenshot kwa support. Ukurasa huu haupandishi
          video yako yoyote — unatuma byte 1,024 mara mbili, na kisha server inafuta
          kila kitu.
        </p>

        <Link href="/creator/upload" className="btn-ghost text-xs inline-flex mt-4">
          ← Rudi kwenye upload
        </Link>
      </main>
    </div>
  );
}
