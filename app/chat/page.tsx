"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import TacticalMap from "@/components/TacticalMap";

interface MapImageData {
  url: string;
  map: string;
  phases?: Array<{
    index: number;
    name: string;
    timing?: string;
    type?: string;
    description?: string;
  }>;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  mapImage?: MapImageData | null;
  mapPending?: string | null; // map name while generating
}

function looksLikeTacticalJson(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    /"map"\s*:/.test(lower) &&
    /"players"\s*:/.test(lower) &&
    (/"utility"\s*:/.test(lower) || /"arrows"\s*:/.test(lower) || /"phases"\s*:/.test(lower))
  );
}

function findBalancedJsonEnd(text: string, startIndex: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let index = startIndex; index < text.length; index++) {
    const ch = text[index];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function stripInlineTacticalJson(content: string): string {
  let output = "";
  let index = 0;

  while (index < content.length) {
    if (content[index] !== "{") {
      output += content[index];
      index++;
      continue;
    }

    const end = findBalancedJsonEnd(content, index);
    if (end === -1) {
      output += content.slice(index);
      break;
    }

    const candidate = content.slice(index, end + 1);
    if (looksLikeTacticalJson(candidate)) {
      index = end + 1;
      continue;
    }

    output += candidate;
    index = end + 1;
  }

  return output;
}

function stripTacticalJson(content: string): string {
  const withoutFences = content.replace(
    /```([a-z0-9_-]*)[^\n]*\n([\s\S]*?)```/gi,
    (match, language: string, body: string) => {
      const lang = language.toLowerCase();
      if (lang === "tactical") return "";
      if ((lang === "json" || lang === "") && looksLikeTacticalJson(body)) return "";
      return match;
    }
  );

  return stripInlineTacticalJson(withoutFences).replace(/\n{3,}/g, "\n\n").trim();
}

function MarkdownRenderer({ content }: { content: string }) {
  const cleaned = stripTacticalJson(content);
  return (
    <div className="markdown-body text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-xl font-bold text-gray-100 mt-4 mb-2">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-lg font-bold text-gray-100 mt-4 mb-2">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-base font-bold text-gray-100 mt-3 mb-1">{children}</h3>
          ),
          p: ({ children }) => (
            <p className="text-gray-200 mb-2 last:mb-0">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="list-disc list-inside text-gray-200 mb-2 space-y-1">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal list-inside text-gray-200 mb-2 space-y-1">{children}</ol>
          ),
          li: ({ children }) => (
            <li className="text-gray-200">{children}</li>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-gray-100">{children}</strong>
          ),
          em: ({ children }) => (
            <em className="text-accent-purple-light italic">{children}</em>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-accent-purple/50 pl-3 my-2 text-gray-400 italic">
              {children}
            </blockquote>
          ),
          code: ({ className, children }) => {
            const isInline = !className;
            if (isInline) {
              return (
                <code className="bg-gray-800/50 px-1.5 py-0.5 rounded text-accent-purple-light text-xs">
                  {children}
                </code>
              );
            }
            return (
              <code className={`${className} block bg-gray-900 rounded-lg p-3 my-2 text-xs overflow-x-auto`}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="bg-gray-900 rounded-lg p-3 my-2 overflow-x-auto text-xs">
              {children}
            </pre>
          ),
          hr: () => (
            <hr className="border-surface-border my-3" />
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-2">
              <table className="min-w-full text-sm border border-surface-border rounded-lg">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-gray-800/50">{children}</thead>
          ),
          tbody: ({ children }) => (
            <tbody className="divide-y divide-surface-border">{children}</tbody>
          ),
          tr: ({ children }) => (
            <tr className="border-b border-surface-border">{children}</tr>
          ),
          th: ({ children }) => (
            <th className="px-3 py-2 text-left text-gray-300 font-semibold">{children}</th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-2 text-gray-300">{children}</td>
          ),
        }}
      >
        {cleaned}
      </ReactMarkdown>
    </div>
  );
}

function ChatContent() {
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") || "";

  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content:
        "👋 Welcome to CS2 Knowledge Hub! I can answer questions about Counter-Strike 2 strategy, maps, aim, and pro play using the knowledge base. What would you like to learn about?",
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const initialQuerySent = useRef(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isLoading) return;

    const userMessage = text.trim();
    const requestMessages = [
      ...messages,
      { role: "user" as const, content: userMessage },
    ]
      .filter((message) => message.content.trim().length > 0)
      .slice(-12)
      .map(({ role, content }) => ({ role, content }));

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setIsLoading(true);
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: requestMessages,
        }),
      });

      if (!response.ok) {
        throw new Error("Chat API error");
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let assistantContent = "";
      let buffer = ""; // Buffer for incomplete SSE lines

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last (potentially incomplete) line in the buffer
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ")) {
            const data = trimmed.slice(6);
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.content) {
                assistantContent += parsed.content;
                setMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: "assistant",
                    content: assistantContent,
                  };
                  return updated;
                });
              }
              // Detect map pending (skeleton) event
              if (parsed.mapPending) {
                const pendingMap = parsed.mapPending as string;
                console.log("[chat] Map pending, showing skeleton for:", pendingMap);
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  updated[updated.length - 1] = {
                    ...last,
                    mapPending: pendingMap,
                  };
                  return updated;
                });
              }
              // Detect tactical map image event
              if (parsed.mapImage) {
                console.log("[chat] Received mapImage event:", parsed.mapImage);
                const mapImg = parsed.mapImage as MapImageData;
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  updated[updated.length - 1] = {
                    ...last,
                    mapImage: mapImg,
                    mapPending: null, // clear skeleton
                  };
                  return updated;
                });
              }
            } catch (parseError) {
              console.warn("[chat] Skipping malformed SSE chunk:", parseError);
            }
          }
        }
      }
    } catch (error) {
      console.error("Chat error:", error);
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: "assistant",
          content: "❌ Sorry, I encountered an error. Please try again.",
        };
        return updated;
      });
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, messages]);

  // Auto-send initial query from ?q= param
  useEffect(() => {
    if (initialQuery && !initialQuerySent.current) {
      initialQuerySent.current = true;
      setInput(initialQuery);
      setTimeout(() => {
        sendMessage(initialQuery);
      }, 100);
    }
  }, [initialQuery, sendMessage]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    sendMessage(input);
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] bg-[#0a0d12]/30">
      {/* Chat Header */}
      <div className="border-b border-surface-border px-4 md:px-6 py-3 flex items-center gap-3 bg-[#0a0d12]/60 backdrop-blur-sm">
        <span className="text-xl" aria-hidden>
          🎯
        </span>
        <div>
          <h1 className="font-black uppercase tracking-wide text-gray-100 text-sm md:text-base">
            Tactical briefing
          </h1>
          <p className="text-[10px] md:text-xs font-semibold uppercase tracking-wider text-accent-purple/80">
            RAG + DeepSeek · CS2 knowledge base
          </p>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4 md:px-6 bg-gradient-to-b from-transparent to-[#080b0f]/80">
        {messages.map((msg, i) => (
          <div key={i}>
            <div
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-3xl rounded-2xl px-5 py-3 ${
                  msg.role === "user"
                    ? "bg-accent-purple/20 border border-accent-purple/40 text-gray-100 shadow-[inset_0_1px_0_rgba(255,152,0,0.08)]"
                    : "bg-surface-card/90 backdrop-blur-sm border border-surface-border text-gray-200 shadow-[0_8px_30px_rgba(0,0,0,0.35)]"
                }`}
              >
                {msg.role === "user" ? (
                  <div className="text-sm leading-relaxed">{msg.content}</div>
                ) : msg.content ? (
                  <MarkdownRenderer content={msg.content} />
                ) : (
                  <span className="animate-pulse text-gray-500">Thinking...</span>
                )}
              </div>
            </div>
            {/* Map skeleton while generating */}
            {msg.role === "assistant" && msg.mapPending && !msg.mapImage && (
              <div className="-mx-4 md:mx-0 w-[calc(100%+2rem)] md:w-1/3 mt-2">
                <div className="tm-wrapper">
                  <div className="tm-toolbar">
                    <span className="text-xs font-bold uppercase tracking-wider text-accent-purple/70">
                      🗺️ {msg.mapPending.toUpperCase()} — Generating tactical map…
                    </span>
                  </div>
                  <div className="tm-svg-container" style={{ aspectRatio: "1/1", background: "#0d1117" }}>
                    {/* Grid skeleton */}
                    <svg width="100%" height="100%" viewBox="0 0 1280 1280" style={{ opacity: 0.15 }}>
                      {Array.from({ length: 17 }).map((_, i) => (
                        <line key={`h${i}`} x1="0" y1={i * 80} x2="1280" y2={i * 80} stroke="#DE9B35" strokeWidth="1" />
                      ))}
                      {Array.from({ length: 17 }).map((_, i) => (
                        <line key={`v${i}`} x1={i * 80} y1="0" x2={i * 80} y2="1280" stroke="#DE9B35" strokeWidth="1" />
                      ))}
                      <circle cx="640" cy="640" r="60" fill="none" stroke="#DE9B35" strokeWidth="2" strokeDasharray="8 4" />
                      <line x1="620" y1="640" x2="660" y2="640" stroke="#DE9B35" strokeWidth="2" />
                      <line x1="640" y1="620" x2="640" y2="660" stroke="#DE9B35" strokeWidth="2" />
                    </svg>
                    {/* Pulsing overlay */}
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="flex items-center gap-3 px-5 py-3 rounded-xl bg-black/60 backdrop-blur-sm border border-accent-purple/30">
                        <div className="w-5 h-5 border-2 border-accent-purple/60 border-t-accent-purple rounded-full animate-spin" />
                        <span className="text-sm font-semibold text-gray-300">Generating map…</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
            {/* Map on its own row, full-width on mobile, 1/3 on desktop */}
            {msg.role === "assistant" && msg.mapImage && (
              <div className="-mx-4 md:mx-0 w-[calc(100%+2rem)] md:w-1/3 mt-2">
                <TacticalMap
                  svgUrl={msg.mapImage.url}
                  mapName={msg.mapImage.map}
                  phases={msg.mapImage.phases}
                />
              </div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-surface-border p-4 bg-[#080b0f]/90 backdrop-blur-md">
        <form onSubmit={handleSubmit} className="max-w-4xl mx-auto flex gap-3 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit(e);
              }
            }}
            placeholder="Ask about CS2 strategy, aim, maps, economy..."
            rows={1}
            className="flex-1 px-4 py-3 bg-[#050708] border border-surface-border rounded-xl
                       text-gray-100 placeholder-gray-600 resize-none shadow-inner
                       focus:outline-none focus:border-accent-purple/55 focus:ring-2 focus:ring-accent-purple/22
                       transition-all duration-200"
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="px-6 py-3 min-h-[48px] rounded-xl font-bold uppercase tracking-wide text-[#0d1117] bg-gradient-to-r from-accent-purple to-accent-orange
                       hover:from-accent-purple-light hover:to-accent-orange-light disabled:opacity-50 disabled:cursor-not-allowed
                       transition-all duration-200 shadow-[0_0_24px_rgba(222,155,53,0.25)]"
          >
            {isLoading ? "..." : "Send"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-screen text-gray-500">Loading...</div>}>
      <ChatContent />
    </Suspense>
  );
}
