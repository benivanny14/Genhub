"use client";

import { useState, useEffect, useRef } from "react";
import { fetchCurrentUser } from "@/lib/current-user";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import { Mail, Send, Inbox, MessageSquare } from "lucide-react";
import { useTheme } from "@/lib/ThemeProvider";
import { useToast } from "@/components/Toast";
import { formatRelativeTime, cn, formatTZS } from "@/lib/utils";

interface Partner {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: string;
}

interface Conversation {
  partner: Partner;
  lastMessage: Message;
  unreadCount: number;
}

interface Message {
  id: string;
  senderId: string;
  receiverId: string;
  amount: number;
  content: string;
  isRead: boolean;
  createdAt: string;
  sender?: Partner;
}

// Demo fallback so the UI is explorable without a database
const DEMO_PARTNER: Partner = {
  id: "demo-creator-1",
  displayName: "Amani Styles",
  avatarUrl: null,
  role: "CREATOR",
};

const DEMO_MESSAGES: Message[] = [
  {
    id: "demo-m1",
    senderId: "demo-user-9",
    receiverId: "me",
    amount: 1000,
    content: "Hey! Loved the Midnight Sessions video. Any behind-the-scenes coming?",
    isRead: true,
    createdAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
    sender: { id: "demo-user-9", displayName: "Baraka M.", avatarUrl: null, role: "VIEWER" },
  },
  {
    id: "demo-m2",
    senderId: "demo-creator-1",
    receiverId: "me",
    amount: 0,
    content: "Thanks for the support! 🙏 Yes — a full BTS drops on Friday for subscribers.",
    isRead: true,
    createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    sender: DEMO_PARTNER,
  },
];

export default function InboxPage() {
  const [user, setUser] = useState<{ id: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [demoMode, setDemoMode] = useState(false);
  const [activePartner, setActivePartner] = useState<Partner | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [content, setContent] = useState("");
  const [amount, setAmount] = useState("100");
  const [sending, setSending] = useState(false);
  // Where to send a signed-out visitor so the conversation survives the sign-in
  // round trip. Set after mount (it is read from the URL), never during render,
  // so the server and the first client render agree.
  const [signInHref, setSignInHref] = useState("/login");
  const threadRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { theme } = useTheme();
  const { toast } = useToast();
  const isLight = theme === "light";

  useEffect(() => {
    init();
    // "Message" on a creator page is a link a signed-out visitor can follow, so
    // the sign-in link has to bring them back here — otherwise they sign in and
    // land on the home page, with the creator they wanted to write to gone.
    const query = new URLSearchParams(window.location.search);
    if (query.get("userId")) {
      setSignInHref(`/login?redirect=${encodeURIComponent(`/inbox?${query.toString()}`)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [messages]);

  async function init() {
    try {
      const res = await fetchCurrentUser();
      if (res.status === 401) {
        setLoading(false);
        return;
      }
      const data = await res.json().catch(() => null);
      if (data?.success) {
        setUser(data.data);
      } else {
        setUser({ id: "" });
      }
      const list = await fetchConversations();
      await openRequestedPartner(list);
    } catch {
      // Server unreachable — leave signed-out state
    }
    setLoading(false);
  }

  async function fetchConversations(): Promise<Conversation[]> {
    try {
      const res = await fetch("/api/messages");
      const data = await res.json();
      if (data.success) {
        const list: Conversation[] = data.data.conversations || [];
        setConversations(list);
        setDemoMode(false);
        return list;
      }
    } catch {}
    const demo = [{ partner: DEMO_PARTNER, lastMessage: DEMO_MESSAGES[1], unreadCount: 0 }];
    setConversations(demo);
    setDemoMode(true);
    return demo;
  }

  /**
   * `?userId=` opens that conversation straight away.
   *
   * This is how "Message creator" on a profile or a video page works. Without
   * it the viewer landed on the inbox with nothing selected, and a creator they
   * had never written to does not appear in the conversation list at all (that
   * list is built from existing messages), so there was no way to send the
   * first one.
   *
   * Read from window.location rather than useSearchParams() so this page stays
   * statically rendered — the same reason the login page reads it that way.
   */
  async function openRequestedPartner(list: Conversation[]) {
    if (typeof window === "undefined") return;
    const id = new URLSearchParams(window.location.search).get("userId");
    if (!id) return;

    const known = list.find((c) => c.partner.id === id);
    if (known) {
      await openConversation(known.partner);
      return;
    }

    try {
      const res = await fetch(`/api/creators/${id}`);
      const data = await res.json();
      if (data?.success) {
        await openConversation({
          id: data.data.id,
          displayName: data.data.displayName,
          avatarUrl: data.data.avatarUrl,
          role: "CREATOR",
        });
        return;
      }
    } catch {}

    toast("warning", "That creator could not be loaded.");
    router.replace("/inbox");
  }

  async function openConversation(partner: Partner) {
    setActivePartner(partner);

    if (demoMode) {
      setMessages(DEMO_MESSAGES);
      return;
    }

    setThreadLoading(true);
    try {
      const res = await fetch(`/api/messages?userId=${partner.id}`);
      const data = await res.json();
      if (data.success) {
        setMessages([...(data.data || [])].reverse());
      }
    } catch {
      setMessages(DEMO_MESSAGES);
    } finally {
      setThreadLoading(false);
    }
  }

  async function handleSend() {
    if (!activePartner || !content.trim() || sending) return;
    const amt = Math.max(0, parseInt(amount) || 0);
    if (amt < 100) {
      toast("error", "Minimum paid message is TZS 100");
      return;
    }
    setSending(true);
    try {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiverId: activePartner.id, amount: amt, content: content.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        toast("success", "Message sent");
        setContent("");
        await openConversation(activePartner);
        await fetchConversations();
      } else if (res.status === 402 || /balance is too low/i.test(data.error || "")) {
        // Paying for a message comes out of the wallet, and a first-time sender
        // has no reason to know that. Name the fix instead of the failure.
        toast(
          "error",
          `${data.error || "Your wallet balance is too low"} — top up on the Wallet page.`
        );
      } else {
        toast("error", data.error || "Could not send message");
      }
    } catch {
      toast("error", "Could not send message");
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen">
        <Header />
        <div className="max-w-5xl mx-auto px-4 py-8">
          <div className="skeleton h-96 rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen page-enter">
      <Header />

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <div className="flex items-center gap-3">
          <Mail className="w-7 h-7 text-brand-400" />
          <div>
            <h1 className="text-2xl font-display font-bold">Inbox</h1>
            <p className={cn("text-sm", isLight ? "text-gray-500" : "text-white/50")}>
              Direct messages — paid messages credit the creator instantly
            </p>
          </div>
        </div>

        {!user ? (
          <div className={cn(
            "rounded-2xl p-10 text-center border",
            isLight ? "bg-white border-gray-200" : "bg-surface-400/40 border-white/5"
          )}>
            <MessageSquare className={cn("w-12 h-12 mx-auto mb-4", isLight ? "text-gray-300" : "text-white/20")} />
            <h2 className={cn("text-xl font-display font-bold mb-2", isLight ? "text-gray-900" : "text-white")}>
              Sign in to open your inbox
            </h2>
            <p className={cn("text-sm mb-6", isLight ? "text-gray-500" : "text-white/50")}>
              Message creators directly and unlock paid replies.
            </p>
            <div className="flex items-center justify-center gap-3">
              <Link href={signInHref} className="btn-ghost">Sign In</Link>
              <Link href="/register" className="btn-brand">Create Account</Link>
            </div>
          </div>
        ) : (
          <>
            {demoMode && (
              <div className={cn(
                "rounded-xl px-4 py-3 text-sm border",
                isLight
                  ? "bg-amber-50 text-amber-700 border-amber-100"
                  : "bg-amber-500/10 text-amber-400 border-amber-500/20"
              )}>
                Demo data is showing — connect a database to use your real inbox.
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Conversation list */}
              <div className={cn(
                "rounded-2xl border overflow-hidden",
                isLight ? "bg-white border-gray-200" : "bg-surface-400/40 border-white/5"
              )}>
                <div className={cn(
                  "px-4 py-3 border-b font-medium text-sm",
                  isLight ? "border-gray-100 text-gray-900" : "border-white/5 text-white"
                )}>
                  Conversations
                </div>
                {conversations.length === 0 ? (
                  <div className="p-8 text-center">
                    <Inbox className={cn("w-10 h-10 mx-auto mb-3", isLight ? "text-gray-300" : "text-white/20")} />
                    <p className={cn("text-sm", isLight ? "text-gray-400" : "text-white/40")}>
                      No conversations yet
                    </p>
                  </div>
                ) : (
                  <div className="divide-y max-h-[60vh] overflow-y-auto">
                    {conversations.map((conv) => (
                      <button
                        key={conv.partner.id}
                        onClick={() => openConversation(conv.partner)}
                        className={cn(
                          "w-full flex items-center gap-3 px-4 py-3 text-left transition",
                          activePartner?.id === conv.partner.id
                            ? isLight ? "bg-brand-50" : "bg-brand-500/10"
                            : isLight ? "hover:bg-gray-50" : "hover:bg-white/5"
                        )}
                      >
                        <div className="w-10 h-10 rounded-full bg-brand-500/20 flex items-center justify-center text-brand-400 font-bold shrink-0">
                          {conv.partner.displayName?.[0] || "U"}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className={cn("text-sm font-medium truncate", isLight ? "text-gray-800" : "text-white")}>
                              {conv.partner.displayName || "User"}
                            </span>
                            <span className={cn("text-[10px] shrink-0", isLight ? "text-gray-400" : "text-white/30")}>
                              {formatRelativeTime(new Date(conv.lastMessage.createdAt))}
                            </span>
                          </div>
                          <p className={cn("text-xs truncate", isLight ? "text-gray-500" : "text-white/50")}>
                            {conv.lastMessage.content}
                          </p>
                        </div>
                        {conv.unreadCount > 0 && (
                          <span className="w-5 h-5 rounded-full bg-brand-500 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
                            {conv.unreadCount}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Thread */}
              <div className={cn(
                "lg:col-span-2 rounded-2xl border flex flex-col min-h-[420px] overflow-hidden",
                isLight ? "bg-white border-gray-200" : "bg-surface-400/40 border-white/5"
              )}>
                {!activePartner ? (
                  <div className="flex-1 flex items-center justify-center p-8 text-center">
                    <div>
                      <MessageSquare className={cn("w-10 h-10 mx-auto mb-3", isLight ? "text-gray-300" : "text-white/20")} />
                      <p className={cn("text-sm", isLight ? "text-gray-400" : "text-white/40")}>
                        Select a conversation to start messaging
                      </p>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Thread header */}
                    <div className={cn(
                      "flex items-center gap-3 px-4 py-3 border-b",
                      isLight ? "border-gray-100" : "border-white/5"
                    )}>
                      <div className="w-8 h-8 rounded-full bg-brand-500/20 flex items-center justify-center text-brand-400 font-bold text-sm">
                        {activePartner.displayName?.[0] || "U"}
                      </div>
                      <span className={cn("font-medium text-sm", isLight ? "text-gray-900" : "text-white")}>
                        {activePartner.displayName || "User"}
                      </span>
                      <span className={cn("text-[10px] px-1.5 py-0.5 rounded", isLight ? "bg-gray-100 text-gray-500" : "bg-white/10 text-white/50")}>
                        {activePartner.role}
                      </span>
                    </div>

                    {/* Messages */}
                    <div ref={threadRef} className="flex-1 overflow-y-auto p-4 space-y-3 max-h-[45vh]">
                      {threadLoading ? (
                        <div className="space-y-3">
                          {[0, 1, 2].map((i) => (
                            <div key={i} className={cn("h-12 rounded-xl w-2/3 animate-pulse", isLight ? "bg-gray-100" : "bg-white/5")} />
                          ))}
                        </div>
                      ) : messages.length === 0 ? (
                        <p className={cn("text-sm text-center py-10", isLight ? "text-gray-400" : "text-white/30")}>
                          No messages yet. Say hello!
                        </p>
                      ) : (
                        messages.map((m) => {
                          const mine = m.senderId === user?.id || (m.sender?.id === user?.id);
                          return (
                            <div key={m.id} className={cn("flex", mine ? "justify-end" : "justify-start")}>
                              <div className={cn(
                                "max-w-[80%] rounded-2xl px-4 py-2.5",
                                mine
                                  ? "bg-brand-500 text-white rounded-br-md"
                                  : isLight ? "bg-gray-100 text-gray-800 rounded-bl-md" : "bg-surface-300/60 text-white/90 rounded-bl-md"
                              )}>
                                {m.amount > 0 && (
                                  <span className={cn(
                                    "inline-block text-[10px] font-bold px-1.5 py-0.5 rounded mb-1",
                                    mine ? "bg-white/20 text-white" : "bg-amber-500/20 text-amber-500"
                                  )}>
                                    💰 {formatTZS(m.amount)}
                                  </span>
                                )}
                                <p className="text-sm whitespace-pre-wrap break-words">{m.content}</p>
                                <p className={cn("text-[10px] mt-1 text-right", mine ? "text-white/60" : isLight ? "text-gray-400" : "text-white/30")}>
                                  {formatRelativeTime(new Date(m.createdAt))}
                                </p>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>

                    {/* Composer */}
                    <div className={cn("border-t p-3", isLight ? "border-gray-100" : "border-white/5")}>
                      {demoMode ? (
                        <p className={cn("text-xs text-center py-2", isLight ? "text-amber-600" : "text-amber-400")}>
                          Demo mode — connect a database to send real messages.
                        </p>
                      ) : (
                        <div className="flex flex-col sm:flex-row gap-2">
                          <input
                            type="number"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            min={100}
                            max={50000}
                            className={cn("input-field sm:w-28 py-2.5 text-sm")}
                            title="Amount (TZS)"
                          />
                          <input
                            type="text"
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleSend();
                            }}
                            placeholder="Write a message..."
                            className="input-field flex-1 py-2.5 text-sm"
                            maxLength={2000}
                          />
                          <button
                            onClick={handleSend}
                            disabled={sending || !content.trim()}
                            className="btn-brand py-2.5 px-4 flex items-center justify-center gap-2 disabled:opacity-50"
                          >
                            <Send className="w-4 h-4" />
                            {sending ? "Sending..." : "Send"}
                          </button>
                        </div>
                      )}
                      {!demoMode && (
                        <p className={cn("text-[10px] mt-2", isLight ? "text-gray-400" : "text-white/30")}>
                          Every message is a paid message — amount above goes to the creator (min TZS 100).
                        </p>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
