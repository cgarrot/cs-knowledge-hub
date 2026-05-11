"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Message {
  role: "user" | "assistant";
  content: string;
}

function MarkdownRenderer({ content }: { content: string }) {
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
        {content}
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

  // Auto-send initial query from ?q= param
  useEffect(() => {
    if (initialQuery && !initialQuerySent.current) {
      initialQuerySent.current = true;
      setInput(initialQuery);
      setTimeout(() => {
        sendMessage(initialQuery);
      }, 100);
    }
  }, [initialQuery]);

  async function sendMessage(text: string) {
    if (!text.trim() || isLoading) return;

    const userMessage = text.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setIsLoading(true);
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: userMessage }],
        }),
      });

      if (!response.ok) {
        throw new Error("Chat API error");
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let assistantContent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
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
            } catch {
              // Skip malformed chunks
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
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    sendMessage(input);
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Chat Header */}
      <div className="border-b border-surface-border px-6 py-3 flex items-center gap-3">
        <span className="text-2xl">🤖</span>
        <div>
          <h1 className="font-semibold text-gray-100">CS Knowledge Assistant</h1>
          <p className="text-xs text-gray-500">Powered by RAG + DeepSeek</p>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-3xl rounded-2xl px-5 py-3 ${
                msg.role === "user"
                  ? "bg-accent-purple/20 border border-accent-purple/30 text-gray-100"
                  : "bg-surface-card border border-surface-border text-gray-200"
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
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-surface-border p-4">
        <form onSubmit={handleSubmit} className="max-w-4xl mx-auto flex gap-3">
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
            className="flex-1 px-4 py-3 bg-surface-card border border-surface-border rounded-xl
                       text-gray-100 placeholder-gray-500 resize-none
                       focus:outline-none focus:border-accent-purple/50 focus:ring-2 focus:ring-accent-purple/20
                       transition-all duration-200"
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="px-6 py-3 bg-accent-purple rounded-xl font-semibold text-white
                       hover:bg-accent-purple-light disabled:opacity-50 disabled:cursor-not-allowed
                       transition-all duration-200"
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
