/**
 * LLM integration for chat responses.
 * Supports streaming SSE responses using the OpenAI-compatible API format.
 */

import {
  detectMapMention,
  getMapContext,
  TACTICAL_PROMPT_INSTRUCTION,
} from "./map-detection";

const LLM_BASE_URL =
  process.env.LLM_BASE_URL || "https://api.deepseek.com/v1";
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OLLAMA_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "deepseek-chat";

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
 * Clean raw transcript content: remove timestamps, video refs, keep substance.
 */
function cleanForContext(raw: string): string {
  return raw
    // Remove timestamp patterns like "00:25", "09:39", "12:34.5"
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\b/g, "")
    // Remove "[HH:MM:SS]" bracketed timestamps
    .replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, "")
    // Remove lines that are just timestamps or chapter markers
    .replace(/^[\s]*\d{1,2}:\d{2}[\s]*$/gm, "")
    // Remove "at XX:XX" references
    .replace(/\bat \d{1,2}:\d{2}\b/gi, "")
    // Remove excessive whitespace
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Build a RAG system prompt with context from retrieved documents.
 * Optionally enriches the prompt with map-specific context if the user message
 * mentions a CS2 map name.
 */
export function buildRAGPrompt(context: string, userMessage?: string): string {
  const cleanedContext = cleanForContext(context);

  // Detect map mention and append map context + tactical instructions
  let mapSection = "";
  if (userMessage) {
    const mapName = detectMapMention(userMessage);
    if (mapName) {
      const mapCtx = getMapContext(mapName);
      mapSection = `

${mapCtx}

${TACTICAL_PROMPT_INSTRUCTION}`;
    }
  }

  return `You are a CS2 coach and strategy advisor. Your job is to help players improve their Counter-Strike 2 gameplay with clear, actionable advice.

RULES:
- Answer in the SAME LANGUAGE as the user's question (French question = French answer, English = English)
- Be direct and practical — give concrete tips, not vague descriptions
- NEVER mention timestamps, video timecodes, or "at 03:25" references
- NEVER quote the source material verbatim — synthesize and rephrase
- NEVER say "according to the source" or "the analysis shows" — just give the advice
- Structure your answer with clear sections using headers (##) and bullet points
- Include specific callouts: nade lineups, angles to hold, crosshair placement tips, economy rules
- If listing strategies, explain WHY they work, not just WHAT they are
- If the context doesn't cover the topic well, supplement with your CS2 knowledge and say so briefly
- Keep it focused — answer the question, don't dump everything you know
- Use emojis sparingly for visual structure (🎯, 💡, ⚠️)
${mapSection ? `\nMAP CONTEXT AND TACTICAL INSTRUCTIONS:\nWhen the user asks about a specific map, reference the map data provided below.\nYou MUST include a \`\`\`tactical JSON block at the END of your response — this generates a visual map diagram.\nDo NOT skip this step. The user expects to see a tactical map with player positions, utility, and arrows.\n` : ""}
KNOWLEDGE BASE CONTEXT (synthesized from pro player guides and demo analyses):
---
${cleanedContext}
---${mapSection}`;
}

/**
 * Stream a chat completion (OpenAI-compatible SSE).
 * Yields text chunks as they arrive.
 */
export async function* streamChat(
  messages: ChatMessage[],
  options: LLMOptions = {}
): AsyncGenerator<string> {
  const { temperature = 0.6, maxTokens = 4096, topP = 0.9 } = options;

  try {
    const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
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
        `LLM API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    if (!response.body) {
      throw new Error("No response body from LLM API");
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
    yield "Sorry, I encountered an error connecting to the AI service. Please try again later.";
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
