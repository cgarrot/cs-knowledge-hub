/**
 * LLM integration for chat responses.
 * Supports streaming SSE responses using the OpenAI-compatible API format.
 */

import {
  detectMapMention,
  getMapContext,
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
export function buildRAGPrompt(context: string, userMessage?: string, mapNameOverride?: string | null): string {
  const cleanedContext = cleanForContext(context);

  // Detect map mention and append map context + tactical instructions
  let mapSection = "";
  const mapName = mapNameOverride || (userMessage ? detectMapMention(userMessage) : null);
  if (mapName) {
    const mapCtx = getMapContext(mapName);
    mapSection = `
  
${mapCtx}`;
  }

  return `You are a pro CS2 analyst and strategy coach. You help players improve their Counter-Strike 2 gameplay with specific, actionable, pro-level advice drawn from real pro analyses and demos.

RULES:
- Answer in the SAME LANGUAGE as the user's question (French question = French answer, English = English)
- Be specific and tactical — give exact positions ("Triple Box on A site"), utility lineups ("smoke Window from T Spawn, jump-throw aligned on the DNA wall marker"), role assignments ("Player 1 plays anchor at Pillar, Player 2 rotates from Connector")
- NEVER mention timestamps, video timecodes, or "at 03:25" references
- NEVER quote the source material verbatim — synthesize and rephrase
- NEVER say "according to the source" or "the analysis shows" — just give the advice
- Reference pro analysts by name when relevant (EVY, EliGE, DEVIL, WiPR, Elmapuddy, etc.) to add credibility
- Include concrete utility lineups with alignment references (wall markers, jump-throws, run-throws)
- Use CS2-specific terminology: jiggle peek, pop flash, off-angle, crossfire, retake, anchor, lurk, entry, trade
- Structure your answer with clear sections using headers (##) and bullet points
- For map tactics: include 5-player role assignments, utility purpose/timing per phase, movement routes, rotation triggers, post-plant positions, and retake contingencies
- NEVER output tactical JSON, JSON schemas, or fenced tactical/json code blocks; tactical maps are generated internally from your prose
- Explain WHY each setup works — what it punishes, what it counters, how opponents typically respond
- Do NOT give generic advice like "communicate with your team" or "use utility wisely" — give specific calls
- Keep it focused — answer the question, don't dump everything you know
- Use emojis sparingly for visual structure
${mapSection ? `\nMAP CONTEXT:\nWhen the user asks about a specific map, reference the map data provided below to use the correct callout names in your answer.\n` : ""}
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
        } catch (parseError) {
          console.warn("[llm] Skipping malformed SSE JSON line:", parseError);
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
