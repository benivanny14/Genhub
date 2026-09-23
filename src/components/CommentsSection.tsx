"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { MessageCircle, Trash2, Flag, Reply, Send } from "lucide-react";
import { formatRelativeTime } from "@/lib/utils";
import { useTheme } from "@/lib/ThemeProvider";
import { useToast } from "@/components/Toast";
import { cn } from "@/lib/utils";

interface CommentUser {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: string;
}

export interface CommentItem {
  id: string;
  userId: string;
  body: string;
  createdAt: string;
  user: CommentUser;
  replies?: CommentItem[];
}

interface CommentsSectionProps {
  videoId: string;
  user: { id: string; role: string } | null;
}

// Shown when the database is unreachable so the section is never empty
const DEMO_COMMENTS: CommentItem[] = [
  {
    id: "demo-c1",
    userId: "demo-user-1",
    body: "The quality on this one is insane 🔥 Keep it up!",
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    user: { id: "demo-user-1", displayName: "Baraka M.", avatarUrl: null, role: "VIEWER" },
    replies: [
      {
        id: "demo-c1r",
        userId: "demo-creator-1",
        body: "Thank you! More 4K drops coming this weekend 🎬",
        createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
        user: { id: "demo-creator-1", displayName: "Amani Styles", avatarUrl: null, role: "CREATOR" },
      },
    ],
  },
  {
    id: "demo-c2",
    userId: "demo-user-2",
    body: "Worth every shilling. The teaser sold me instantly.",
    createdAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    user: { id: "demo-user-2", displayName: "Neema K.", avatarUrl: null, role: "VIEWER" },
  },
  {
    id: "demo-c3",
    userId: "demo-user-3",
    body: "Can we get a part 2? 🙏",
    createdAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
    user: { id: "demo-user-3", displayName: "Juma P.", avatarUrl: null, role: "VIEWER" },
  },
];

export default function CommentsSection({ videoId, user }: CommentsSectionProps) {
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [demoMode, setDemoMode] = useState(false);
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { theme } = useTheme();
  const { toast } = useToast();
  const isLight = theme === "light";

  useEffect(() => {
    fetchComments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  async function fetchComments() {
    setLoading(true);
    try {
      const res = await fetch(`/api/videos/${videoId}/comments`);
      const data = await res.json();
      if (data.success) {
        setComments(data.data.comments || []);
        setTotal(data.data.total || 0);
        setDemoMode(false);
        return;
      }
    } catch {}
    // Database unreachable — fall back to demo comments
    setComments(DEMO_COMMENTS);
    setTotal(DEMO_COMMENTS.reduce((n, c) => n + 1 + (c.replies?.length || 0), 0));
    setDemoMode(true);
    setLoading(false);
  }

  async function submitComment(parentId: string | null, body: string) {
    if (!body.trim() || submitting) return;
    if (!user) {
      toast("warning", "Sign in to comment");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/videos/${videoId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: body.trim(), parentId }),
      });
      const data = await res.json();
      if (data.success) {
        toast("success", "Comment posted");
        if (parentId) setReplyText("");
        else setText("");
        setReplyTo(null);
        await fetchComments();
      } else {
        toast("error", data.error || "Could not post comment");
      }
    } catch {
      toast("error", "Could not post comment");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(commentId: string) {
    try {
      const res = await fetch(`/api/comments/${commentId}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        toast("success", "Comment deleted");
        await fetchComments();
      } else {
        toast("error", data.error || "Could not delete comment");
      }
    } catch {
      toast("error", "Could not delete comment");
    }
  }

  async function handleReport(commentId: string) {
    try {
      const res = await fetch(`/api/comments/${commentId}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "INAPPROPRIATE" }),
      });
      const data = await res.json();
      if (data.success) {
        toast("success", "Report submitted — moderators will review it");
      } else {
        toast("error", data.error || "Could not submit report");
      }
    } catch {
      toast("error", "Could not submit report");
    }
  }

  function renderComment(comment: CommentItem, isReply = false) {
    const canDelete = user && (user.id === comment.userId || user.role === "ADMIN");

    return (
      <div key={comment.id} className={cn(isReply && "ml-6 sm:ml-10 border-l-2 pl-4", isReply ? (isLight ? "border-gray-100" : "border-white/5") : "")}>
        <div className={cn("flex items-start gap-3", isReply ? "mt-4" : "py-4", !isReply && (isLight ? "border-b border-gray-100" : "border-b border-white/5"))}>
          {/* Avatar */}
          <div className={cn(
            "w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium shrink-0",
            comment.user.role === "CREATOR"
              ? "bg-brand-500/20 text-brand-400"
              : isLight ? "bg-gray-100 text-gray-500" : "bg-surface-300/60 text-white/60"
          )}>
            {comment.user.displayName?.[0] || "U"}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={cn("text-sm font-medium", isLight ? "text-gray-800" : "text-white")}>
                {comment.user.displayName || "Anonymous"}
              </span>
              {comment.user.role === "CREATOR" && (
                <span className="bg-brand-500/15 text-brand-400 text-[10px] font-bold px-1.5 py-0.5 rounded">
                  CREATOR
                </span>
              )}
              <span className={cn("text-xs", isLight ? "text-gray-400" : "text-white/30")}>
                {formatRelativeTime(new Date(comment.createdAt))}
              </span>
            </div>

            <p className={cn("text-sm mt-1 whitespace-pre-wrap break-words", isLight ? "text-gray-600" : "text-white/70")}>
              {comment.body}
            </p>

            {/* Actions */}
            {!demoMode && (
              <div className="flex items-center gap-3 mt-2">
                {user && (
                  <button
                    onClick={() => {
                      setReplyTo(replyTo === comment.id ? null : comment.id);
                      setReplyText("");
                    }}
                    className={cn(
                      "flex items-center gap-1 text-xs transition",
                      isLight ? "text-gray-400 hover:text-brand-600" : "text-white/40 hover:text-brand-400"
                    )}
                  >
                    <Reply className="w-3 h-3" /> Reply
                  </button>
                )}
                <button
                  onClick={() => handleReport(comment.id)}
                  className={cn(
                    "flex items-center gap-1 text-xs transition",
                    isLight ? "text-gray-400 hover:text-red-500" : "text-white/40 hover:text-red-400"
                  )}
                >
                  <Flag className="w-3 h-3" /> Report
                </button>
                {canDelete && (
                  <button
                    onClick={() => handleDelete(comment.id)}
                    className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition"
                  >
                    <Trash2 className="w-3 h-3" /> Delete
                  </button>
                )}
              </div>
            )}

            {/* Reply input */}
            {replyTo === comment.id && !demoMode && (
              <div className="flex items-center gap-2 mt-3">
                <input
                  type="text"
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitComment(comment.id, replyText);
                  }}
                  placeholder="Write a reply..."
                  className={cn("input-field py-2 text-sm flex-1")}
                  autoFocus
                />
                <button
                  onClick={() => submitComment(comment.id, replyText)}
                  disabled={submitting || !replyText.trim()}
                  className="btn-brand px-3 py-2 disabled:opacity-50"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Replies */}
        {comment.replies?.map((reply) => renderComment(reply, true))}
      </div>
    );
  }

  return (
    <section aria-label="Comments">
      <div className="flex items-center gap-2 mb-4">
        <MessageCircle className={cn("w-5 h-5", isLight ? "text-brand-600" : "text-brand-400")} />
        <h2 className={cn("font-display font-bold text-lg", isLight ? "text-gray-900" : "text-white")}>
          Comments
        </h2>
        <span className={cn("text-sm", isLight ? "text-gray-400" : "text-white/40")}>
          ({total})
        </span>
      </div>

      {/* New comment input */}
      {demoMode ? (
        <div className={cn(
          "rounded-xl px-4 py-3 mb-6 text-sm",
          isLight ? "bg-amber-50 text-amber-700 border border-amber-100" : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
        )}>
          Demo data is showing — connect a database to join the conversation.
        </div>
      ) : user ? (
        <div className="flex items-start gap-3 mb-6">
          <div className="w-8 h-8 rounded-full bg-brand-500/20 flex items-center justify-center text-brand-400 text-xs font-medium shrink-0">
            {user.id[0]?.toUpperCase() || "U"}
          </div>
          <div className="flex-1">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Join the conversation..."
              rows={2}
              className={cn("input-field w-full resize-none py-2.5 text-sm")}
              maxLength={1000}
            />
            <div className="flex justify-end mt-2">
              <button
                onClick={() => submitComment(null, text)}
                disabled={submitting || !text.trim()}
                className="btn-brand text-sm py-2 px-4 flex items-center gap-2 disabled:opacity-50"
              >
                {submitting ? "Posting..." : (<><Send className="w-4 h-4" /> Post</>)}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className={cn(
          "rounded-xl px-4 py-3 mb-6 text-sm flex items-center justify-between gap-3 flex-wrap",
          isLight ? "bg-gray-50 text-gray-500 border border-gray-100" : "bg-surface-300/40 text-white/50 border border-white/5"
        )}>
          <span>Sign in to join the conversation.</span>
          <Link href="/login" className="text-brand-400 hover:underline font-medium">
            Sign In
          </Link>
        </div>
      )}

      {/* Comment list */}
      {loading ? (
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-start gap-3 animate-pulse">
              <div className={cn("w-8 h-8 rounded-full", isLight ? "bg-gray-100" : "bg-white/10")} />
              <div className="flex-1 space-y-2">
                <div className={cn("h-3 rounded w-1/4", isLight ? "bg-gray-100" : "bg-white/10")} />
                <div className={cn("h-3 rounded w-3/4", isLight ? "bg-gray-100" : "bg-white/5")} />
              </div>
            </div>
          ))}
        </div>
      ) : comments.length === 0 ? (
        <p className={cn("text-sm text-center py-8", isLight ? "text-gray-400" : "text-white/30")}>
          No comments yet. Be the first to comment!
        </p>
      ) : (
        <div className="divide-y divide-transparent">
          {comments.map((comment) => renderComment(comment))}
        </div>
      )}
    </section>
  );
}
