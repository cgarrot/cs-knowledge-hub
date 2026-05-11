/**
 * Ollama Cloud LLM integration for chat responses.
 * Supports streaming SSE responses.
 */

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "https://api.ollama.cloud";
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || "";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

/**
 * Build a RAG system prompt with context from retrieved documents.
 */
export function buildRAGPrompt(context: string): string {
  return `You are a helpful CS Knowledge Hub assistant. You answer questions about computer science topics using the provided context. If the context doesn't contain enough information, say so honestly. Always cite the source documents when possible.

Context from knowledge base:
---
${context}
---

Instructions:
- Answer the user's question using the context above
- Be concise but thorough
- Use code examples when relevant
- If you're unsure, say so rather than guessing`;
}

/**
 * Stream a chat completion from Ollama Cloud.
 * Yields SSE-formatted chunks.
 */
export async function* streamChat(
  messages: ChatMessage[],
  options: LLMOptions = {}
): AsyncGenerator<string> {
  const { temperature = 0.7, maxTokens = 2048 } = options;

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(OLLAMA_API_KEY ? { Authorization: `Bearer ${OLLAMA_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages,
        options: {
          temperature,
          num_predict: maxTokens,
        },
        stream: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error("No response body from Ollama API");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") return;

          try {
            const parsed = JSON.parse(data);
            const content = parsed.message?.content;
            if (content) {
              yield content;
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    }
  } catch (error) {
    console.error("[llm] Error streaming chat:", error);
    yield "I'm sorry, I encountered an error connecting to the AI service. Please try again later.";
  }
}

/**
 * Non-streaming chat completion (for simple queries).
 */
export async function chatCompletion(
  messages: ChatMessage[],
  options: LLMOptions = {}
): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of streamChat(messages, options)) {
    chunks.push(chunk);
  }
  return chunks.join("");
}
