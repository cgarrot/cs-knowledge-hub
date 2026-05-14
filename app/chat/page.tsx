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
}

interface Message {
  role: "user" | "assistant";
  content: string;
  mapImage?: MapImageData | null;
}

function stripTacticalJson(content: string): string {
  // Remove ```tactical ... ``` blocks from markdown before rendering
  return content.replace(/```tactical\s*\n[\s\S]*?```/gi, "").trim();
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
            {/* Map on its own row, full-width on mobile */}
            {msg.role === "assistant" && msg.mapImage && (
              <div className="-mx-4 md:mx-0 w-[calc(100%+2rem)] md:w-full mt-2">
                <TacticalMap
                  svgUrl={msg.mapImage.url}
                  mapName={msg.mapImage.map}
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
