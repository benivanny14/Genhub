"use client";

import { useState, useEffect, useCallback } from "react";
import Header from "@/components/Header";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import { Shield, Upload, CheckCircle, XCircle, Clock, FileText, Camera } from "lucide-react";

export default function KycPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [kycStatus, setKycStatus] = useState<string>("NONE");
  const [rejectionReason, setRejectionReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [idDocUrl, setIdDocUrl] = useState("");
  const [selfieUrl, setSelfieUrl] = useState("");
  const [uploadingField, setUploadingField] = useState<"" | "id" | "selfie">(
    ""
  );

  async function handleImageUpload(
    field: "id" | "selfie",
    file?: File | null
  ) {
    if (!file) return;
    setUploadingField(field);
    try {
      const { uploadImage } = await import("@/lib/upload-client");
      const url = await uploadImage(file);
      if (field === "id") setIdDocUrl(url);
      else setSelfieUrl(url);
    } catch (err) {
      toast("error", err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploadingField("");
    }
  }
  const [idType, setIdType] = useState("NIDA");

  const fetchKycStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/creator/kyc");
      const data = await res.json();
      if (data.success) {
        setKycStatus(data.data.status);
        setRejectionReason(data.data.rejectionReason);
      }
    } catch {
      router.push("/login");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    fetchKycStatus();
  }, [fetchKycStatus]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!idDocUrl || !selfieUrl) return;
    setSubmitting(true);

    try {
      const res = await fetch("/api/creator/kyc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idDocumentUrl: idDocUrl,
          selfieUrl: selfieUrl,
          idDocumentType: idType,
        }),
      });

      const data = await res.json();
      if (data.success) {
        toast("success", "KYC submitted! Please wait for admin review.");
        fetchKycStatus();
      } else {
        toast("error", data.error || "An error occurred");
      }
    } catch {
      toast("error", "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen">
        <Header />
        <div className="flex items-center justify-center h-[60vh]">
          <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen page-enter">
      <Header />

      <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        <div className="text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-brand-500/20 flex items-center justify-center mb-4 glow-brand">
            <Shield className="w-8 h-8 text-brand-400" />
          </div>
          <h1 className="text-2xl font-display font-bold">Identity Verification (KYC)</h1>
          <p className="text-white/50 text-sm mt-2">
            Complete verification to start earning and uploading content.
          </p>
        </div>

        {/* Status */}
        {kycStatus === "APPROVED" && (
          <div className="glass-card p-6 text-center">
            <CheckCircle className="w-12 h-12 text-emerald-400 mx-auto mb-3" />
            <h2 className="text-lg font-bold text-emerald-400">KYC Verified!</h2>
            <p className="text-sm text-white/60 mt-2">
              Your profile has been verified. You can now upload videos and request payouts.
            </p>
            <button onClick={() => router.push("/creator")} className="btn-brand mt-4">
              Back to Dashboard
            </button>
          </div>
        )}

        {kycStatus === "PENDING" && (
          <div className="glass-card p-6 text-center">
            <Clock className="w-12 h-12 text-amber-400 mx-auto mb-3" />
            <h2 className="text-lg font-bold text-amber-400">KYC Under Review</h2>
            <p className="text-sm text-white/60 mt-2">
              Your application is being reviewed. Please wait a moment.
            </p>
          </div>
        )}

        {kycStatus === "REJECTED" && (
          <div className="glass-card p-6">
            <div className="flex items-center gap-3 mb-3">
              <XCircle className="w-8 h-8 text-red-400" />
              <div>
                <h2 className="text-lg font-bold text-red-400">KYC Rejected</h2>
                {rejectionReason && (
                  <p className="text-sm text-white/60 mt-1">Reason: {rejectionReason}</p>
                )}
              </div>
            </div>
            <p className="text-sm text-white/50">
              Please resubmit with correct information.
            </p>
          </div>
        )}

        {/* Submission Form */}
        {(kycStatus === "NONE" || kycStatus === "REJECTED") && (
          <form onSubmit={handleSubmit} className="glass-card p-6 space-y-5">
            <h3 className="font-display font-bold">Submit KYC</h3>

            {/* Instructions */}
            <div className="bg-surface-300/40 rounded-xl p-4 space-y-2">
              <p className="text-sm font-medium">Instructions:</p>
              <ol className="text-xs text-white/60 space-y-1 list-decimal list-inside">
                <li>Take a photo of your government ID (NIDA/Passport)</li>
                <li>Take a selfie holding a card / paper with:</li>
                <li className="ml-4">&quot;Genhub + today&apos;s date&quot; handwritten</li>
                <li>Upload a photo of each below — straight from your phone</li>
              </ol>
            </div>

            {/* ID Type */}
            <div>
              <label className="text-sm text-white/60 mb-2 block">ID Type</label>
              <select value={idType} onChange={(e) => setIdType(e.target.value)} className="input-field">
                <option value="NIDA">NIDA</option>
                <option value="PASSPORT">Passport</option>
                <option value="DRIVING_LICENSE">Driving License</option>
              </select>
            </div>

            {/* ID Document URL */}
            <div>
              <label className="text-sm text-white/60 mb-2 block flex items-center gap-2">
                <FileText className="w-4 h-4" /> ID Document
              </label>
              <label className="flex items-center gap-3 cursor-pointer border-2 border-dashed border-white/20 rounded-xl p-4 hover:border-brand-500/50 transition">
                <span className="text-lg" aria-hidden>
                  📄
                </span>
                <span className="text-sm text-white/70">
                  {uploadingField === "id"
                    ? "Uploading..."
                    : idDocUrl
                    ? "Replace image"
                    : "Choose or take a photo"}
                </span>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={uploadingField === "id"}
                  onChange={(e) => handleImageUpload("id", e.target.files?.[0])}
                />
              </label>
              {idDocUrl && (
                // Creator-supplied URL on an arbitrary host, so next/image
                // cannot optimise it (an unconfigured remotePattern throws).
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={idDocUrl}
                  alt="ID document preview"
                  className="mt-2 h-24 rounded-lg object-cover"
                />
              )}
              <input
                type="url"
                value={idDocUrl}
                onChange={(e) => setIdDocUrl(e.target.value)}
                placeholder="…or paste an image URL"
                className="input-field mt-2"
                required
              />
              <p className="text-xs text-white/40 mt-1">
                Photo of your NIDA/Passport — JPG/PNG, max 5 MB
              </p>
            </div>

            {/* Selfie URL */}
            <div>
              <label className="text-sm text-white/60 mb-2 block flex items-center gap-2">
                <Camera className="w-4 h-4" /> Selfie
              </label>
              <label className="flex items-center gap-3 cursor-pointer border-2 border-dashed border-white/20 rounded-xl p-4 hover:border-brand-500/50 transition">
                <span className="text-lg" aria-hidden>
                  🤳
                </span>
                <span className="text-sm text-white/70">
                  {uploadingField === "selfie"
                    ? "Uploading..."
                    : selfieUrl
                    ? "Replace selfie"
                    : "Choose or take a selfie"}
                </span>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={uploadingField === "selfie"}
                  onChange={(e) =>
                    handleImageUpload("selfie", e.target.files?.[0])
                  }
                />
              </label>
              {selfieUrl && (
                // Creator-supplied URL on an arbitrary host (see above).
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={selfieUrl}
                  alt="Selfie preview"
                  className="mt-2 h-24 rounded-lg object-cover"
                />
              )}
              <input
                type="url"
                value={selfieUrl}
                onChange={(e) => setSelfieUrl(e.target.value)}
                placeholder="…or paste an image URL"
                className="input-field mt-2"
                required
              />
              <p className="text-xs text-white/40 mt-1">
                Selfie holding a paper with &quot;Genhub + today&apos;s date&quot;
              </p>
            </div>

            <button type="submit" disabled={submitting} className="btn-brand w-full">
              {submitting ? "Submitting..." : "Submit KYC"}
            </button>
          </form>
        )}
      </main>
    </div>
  );
}
