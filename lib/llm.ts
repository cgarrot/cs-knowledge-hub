/**
 * Ollama Cloud LLM integration for chat responses.
 * Supports streaming SSE responses using the OpenAI-compatible API format.
 */

const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL || "https://ollama.com/v1";
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || "";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "glm-5.1";

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
  return `You are a helpful CS2 Knowledge Hub assistant specialized in Counter-Strike 2 gameplay, strategy, and professional play. You answer questions using the provided context from pro player guides, demo analyses, and training materials. If the context doesn't contain enough information, say so honestly. Always cite the source when possible.

Context from knowledge base:
---
${context}
---

Instructions:
- Answer the user's question using the context above
- Be concise but thorough
- Use specific examples from the sources when relevant
- If you're unsure, say so rather than guessing
- Reference specific pro players, maps, or strategies mentioned in the sources`;
}

/**
 * Stream a chat completion from ZAI API (OpenAI-compatible SSE).
 * Yields text chunks as they arrive.
 */
export async function* streamChat(
  messages: ChatMessage[],
  options: LLMOptions = {}
): AsyncGenerator<string> {
  const { temperature = 0.7, maxTokens = 2048, topP = 0.9 } = options;

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OLLAMA_API_KEY}`,
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages,
        temperature,
        max_tokens: maxTokens,
        top_p: topP,
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Ollama Cloud API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    if (!response.body) {
      throw new Error("No response body from Ollama Cloud");
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
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            yield content;
          }
        } catch {
          // Skip malformed JSON lines
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
