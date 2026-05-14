import { NextRequest, NextResponse } from "next/server";
import { buildRAGPrompt, streamChat, type ChatMessage } from "@/lib/llm";
import { getDb } from "@/lib/db";
import {
  detectMapMention,
  extractTacticalWithLLM,
  extractTacticalFromText,
  getDefaultTactical,
  repairTacticalCallouts,
  toRendererOptions,
  type TacticalData,
} from "@/lib/map-detection";
import fs from "fs";
import path from "path";
import { writeGeneratedMapSvg } from "@/lib/generated-maps";
import { readLimitedRequestText } from "@/lib/request-body";

export const runtime = "nodejs";
export const maxDuration = 60;

interface IndexEntry {
  file: string;
  category: string;
  subcategory: string;
  skill_level: string;
  language: string;
  topics: string[];
  summary: string;
}

interface MapPhaseMetadata {
  index: number;
  name: string;
  timing?: string;
  type?: string;
  description?: string;
}

interface GeneratedMapImage {
  url: string;
  map: string;
  phases?: MapPhaseMetadata[];
}

const RAW_DIR = process.env.RAW_DIR || path.join(process.env.DATA_DIR || "/data", "sources");
const INDEX_PATH = process.env.CATEGORY_INDEX_PATH || path.join(process.env.DATA_DIR || "/data", "full-index.json");
const LLM_MODEL = process.env.LLM_MODEL || "deepseek-v4-flash";
const MAX_CHAT_BODY_CHARS = 40_000;
const MAX_CHAT_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_TOTAL_MESSAGE_CHARS = 30_000;
const TACTICAL_SANITIZER_TAIL_CHARS = 32_000;

let fileIndexCache: { entries: IndexEntry[]; timestamp: number } | null = null;

function loadFileIndex(): IndexEntry[] {
  if (fileIndexCache && Date.now() - fileIndexCache.timestamp < 60_000) {
    return fileIndexCache.entries;
  }
  try {
    if (fs.existsSync(INDEX_PATH)) {
      const raw = fs.readFileSync(INDEX_PATH, "utf-8");
      const entries: IndexEntry[] = JSON.parse(raw);
      fileIndexCache = { entries, timestamp: Date.now() };
      return entries;
    }
  } catch (e) {
    console.warn("[chat] Failed to load file index:", e);
  }
  fileIndexCache = { entries: [], timestamp: Date.now() };
  return fileIndexCache.entries;
}

function detectLang(text: string): string {
  return /[àâäéèêëïîôùûüÿçœæ]/i.test(text) ? "fr" : "en";
}

function searchRelevantDocs(query: string, maxResults = 8): { context: string; sources: string[] } {
  const q = query.toLowerCase();
  const entries = loadFileIndex();

  const scored: Array<{ entry: IndexEntry; score: number }> = [];
  for (const entry of entries) {
    let score = 0;
    const lowerSummary = entry.summary.toLowerCase();
    const lowerTopics = entry.topics.map(t => t.toLowerCase());
    const lowerCategory = entry.category.toLowerCase();
    const lowerFile = entry.file.toLowerCase();

    const summaryWords = q.split(/\s+/).filter(w => w.length > 2);
    for (const word of summaryWords) {
      if (lowerSummary.includes(word)) score += 3;
      if (lowerTopics.some(t => t.includes(word))) score += 2;
      if (lowerCategory.includes(word)) score += 1;
      if (lowerFile.includes(word)) score += 1;
    }

    if (score > 0) {
      scored.push({ entry, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const topResults = scored.slice(0, maxResults);

  if (topResults.length === 0) {
    return { context: "", sources: [] };
  }

  const sources = topResults.map(r => r.entry.file);
  const contextParts: string[] = [];
  for (const { entry } of topResults) {
    const fullPath = path.join(RAW_DIR, entry.file);
    let content = "";
    try {
      if (fs.existsSync(fullPath)) {
        content = fs.readFileSync(fullPath, "utf-8");
        if (content.startsWith("---")) {
          const endFm = content.indexOf("---", 3);
          if (endFm > 0) {
            content = content.slice(endFm + 3).trim();
          }
        }
        content = content.replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\b/g, "");
        content = content.replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, "");
        content = content.replace(/\n{3,}/g, "\n\n").trim();
        if (content.length > 2500) {
          content = content.slice(0, 2500) + "\n...[truncated]";
        }
      }
    } catch (error) {
      console.warn("[chat] Failed to read indexed source:", error);
    }

    const meta = [
      entry.category ? `Category: ${entry.category}` : "",
      entry.subcategory ? `Sub: ${entry.subcategory}` : "",
    ].filter(Boolean).join(" | ");

    contextParts.push(
      `[${meta} | Source: ${entry.file.split("/").pop()}]\n${content || entry.summary}`
    );
  }

  return { context: contextParts.join("\n\n---\n\n"), sources };
}

// GET /api/chat — return chat history from DB
export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
    const offset = parseInt(url.searchParams.get("offset") || "0");

    const logs = db.prepare(
      "SELECT * FROM chat_history ORDER BY created_at DESC LIMIT ? OFFSET ?"
    ).all(limit, offset) as Array<{
      id: string;
      created_at: string;
      question: string;
      answer: string;
      sources: string | null;
      language: string;
      model: string | null;
      feedback: number | null;
      feedback_comment: string | null;
    }>;

    const total = (db.prepare("SELECT COUNT(*) as c FROM chat_history").get() as { c: number }).c;

    return NextResponse.json({ logs, total });
  } catch {
    return NextResponse.json({ logs: [], total: 0 });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseChatRequest(rawBody: string): { messages?: ChatMessage[]; error?: string; status?: number } {
  if (rawBody.length > MAX_CHAT_BODY_CHARS) {
    return { error: "Chat request body is too large", status: 413 };
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { error: "Invalid JSON request body", status: 400 };
  }

  if (!isRecord(body) || !Array.isArray(body.messages)) {
    return { error: "No messages provided", status: 400 };
  }

  if (body.messages.length === 0) {
    return { error: "No messages provided", status: 400 };
  }
  if (body.messages.length > MAX_CHAT_MESSAGES) {
    return { error: `Too many messages; max ${MAX_CHAT_MESSAGES}`, status: 400 };
  }

  let totalChars = 0;
  const messages: ChatMessage[] = [];
  for (const [index, message] of body.messages.entries()) {
    if (!isRecord(message)) {
      return { error: `Message ${index} must be an object`, status: 400 };
    }

    const { role, content } = message;
    if (role !== "user" && role !== "assistant") {
      return { error: `Message ${index} has an invalid role`, status: 400 };
    }
    if (typeof content !== "string" || content.trim().length === 0) {
      return { error: `Message ${index} must include text content`, status: 400 };
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      return { error: `Message ${index} is too long`, status: 413 };
    }

    totalChars += content.length;
    if (totalChars > MAX_TOTAL_MESSAGE_CHARS) {
      return { error: "Chat message payload is too large", status: 413 };
    }

    messages.push({ role, content });
  }

  if (messages[messages.length - 1].role !== "user") {
    return { error: "Last message must be from user", status: 400 };
  }

  return { messages };
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

  return stripInlineTacticalJson(withoutFences).replace(/\n{3,}/g, "\n\n");
}

function sanitizeStreamBuffer(
  buffer: string,
  final = false
): { emit: string; remainder: string } {
  const sanitized = stripTacticalJson(buffer);
  if (final) return { emit: sanitized, remainder: "" };
  if (sanitized.length <= TACTICAL_SANITIZER_TAIL_CHARS) {
    return { emit: "", remainder: sanitized };
  }

  const emitLength = sanitized.length - TACTICAL_SANITIZER_TAIL_CHARS;
  return {
    emit: sanitized.slice(0, emitLength),
    remainder: sanitized.slice(emitLength),
  };
}

function phaseTypeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (/retake|reprise|defuse/.test(lower)) return "retake";
  if (/post[-\s]?plant|after\s+plant/.test(lower)) return "post-plant";
  if (/execute|exec|commit|pop|contact/.test(lower)) return "execute";
  if (/map\s*control|control|default|mid[-\s]?round/.test(lower)) return "map-control";
  if (/rotate|rotation|fallback|regroup/.test(lower)) return "rotation";
  if (/opening|spawn|start|initial|0:00/.test(lower)) return "opening";
  return "custom";
}

function getPhaseMetadata(tactical: TacticalData): MapPhaseMetadata[] {
  return (tactical.phases || []).slice(0, 8).map((phase, index) => ({
    index,
    name: phase.name,
    timing: phase.timing,
    type: phaseTypeFromName(phase.name),
    description: phase.description,
  }));
}

function repairCandidate(
  tactical: TacticalData | null,
  mapName: string,
  source: string
): TacticalData | null {
  if (!tactical) return null;
  const repaired = repairTacticalCallouts({ ...tactical, map: mapName });
  if (!repaired) {
    console.log(`[chat] ${source} tactical data had no valid callouts after repair; trying fallback`);
  }
  return repaired;
}

export async function POST(request: NextRequest) {
  try {
    const rawRequest = await readLimitedRequestText(
      request,
      MAX_CHAT_BODY_CHARS,
      "Chat request body is too large"
    );
    if (rawRequest.error) {
      return NextResponse.json({ error: rawRequest.error }, { status: rawRequest.status || 400 });
    }

    const parsedRequest = parseChatRequest(rawRequest.text || "");
    if (!parsedRequest.messages) {
      return NextResponse.json(
        { error: parsedRequest.error || "Invalid chat request" },
        { status: parsedRequest.status || 400 }
      );
    }
    const { messages } = parsedRequest;

    const lastMessage = messages[messages.length - 1];

    const question = lastMessage.content;
    const { context, sources } = searchRelevantDocs(question, 8);

    // Detect map mention in the current message OR in conversation history
    // This handles follow-up messages like "fait le moi sur la map" after discussing dust2
    let detectedMap = detectMapMention(question);
    if (!detectedMap) {
      // Scan previous messages for map mentions (most recent first)
      for (let i = messages.length - 1; i >= 0; i--) {
        const prevMap = detectMapMention(messages[i].content);
        if (prevMap) {
          detectedMap = prevMap;
          break;
        }
      }
    }

    const systemMessage: ChatMessage = {
      role: "system",
      content: buildRAGPrompt(
        context || "No specific documents found, answer from general CS2 knowledge.",
        question,
        detectedMap
      ),
    };

    const llmMessages: ChatMessage[] = [systemMessage, ...messages];

    let fullResponse = "";
    let visibleBuffer = "";
    const chatId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const encoder = new TextEncoder();
    let closed = false;

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Stream LLM response — NO early default map, we wait for the real data
          for await (const chunk of streamChat(llmMessages)) {
            if (closed) return;
            fullResponse += chunk;
            visibleBuffer += chunk;
            const sanitizedChunk = sanitizeStreamBuffer(visibleBuffer);
            visibleBuffer = sanitizedChunk.remainder;
            if (sanitizedChunk.emit) {
              const data = JSON.stringify({ content: sanitizedChunk.emit });
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            }
          }

          if (!closed) {
            const finalVisibleChunk = sanitizeStreamBuffer(visibleBuffer, true).emit;
            visibleBuffer = "";
            if (finalVisibleChunk) {
              const data = JSON.stringify({ content: finalVisibleChunk });
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            }
            const safeFullResponse = stripTacticalJson(fullResponse).trim();

            // After streaming, extract tactical data from the LLM response and generate map
            let finalMapImage: GeneratedMapImage | undefined;
            try {
              let tactical: TacticalData | null = null;

              // STAGE 1: LLM-based extraction (most reliable)
              if (detectedMap) {
                console.log(`[chat] Attempting LLM extraction for map: ${detectedMap}`);
                tactical = repairCandidate(
                  await extractTacticalWithLLM(fullResponse, detectedMap),
                  detectedMap,
                  "LLM extraction"
                );
              }

              // FALLBACK 1: Text extraction via regex
              if (!tactical && detectedMap) {
                console.log(`[chat] LLM extraction failed, trying text extraction for map: ${detectedMap}`);
                const extracted = extractTacticalFromText(fullResponse, detectedMap);
                if (extracted) {
                  console.log(`[chat] Text extraction succeeded: ${extracted.players.length} players`);
                  tactical = repairCandidate(extracted, detectedMap, "Text extraction");
                }
              }

              // FALLBACK 2: Deterministic defaults
              if (!tactical && detectedMap) {
                console.log(`[chat] Text extraction failed, using defaults for map: ${detectedMap}`);
                tactical = repairCandidate(
                  getDefaultTactical(detectedMap, fullResponse),
                  detectedMap,
                  "Default tactical"
                );
              }

              if (tactical) {
                const result = await generateTacticalMap(tactical);
                if (result) {
                  finalMapImage = result;
                  console.log(`[chat] Sending tactical map for ${tactical.map}: ${tactical.players?.length || 0} players, ${tactical.utility?.length || 0} utility`);
                  const mapData = JSON.stringify({ mapImage: result });
                  controller.enqueue(encoder.encode(`data: ${mapData}\n\n`));
                }
              }
            } catch (mapError) {
              console.warn("[chat] Failed to generate tactical map from stream response:", mapError);
            }

            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            closed = true;

            // Save to DB
            saveChatHistory(chatId, question, safeFullResponse, sources, finalMapImage);
          }
        } catch (error) {
          console.error("[chat] Stream error:", error);
          if (!closed) {
            try {
              const errorData = JSON.stringify({
                content: "An error occurred during streaming.",
              });
              controller.enqueue(encoder.encode(`data: ${errorData}\n\n`));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            } catch (enqueueError) {
              console.warn("[chat] Failed to send stream error event:", enqueueError);
            }
            controller.close();
            closed = true;

            if (fullResponse) {
              saveChatHistory(
                chatId,
                question,
                `${stripTacticalJson(fullResponse).trim()}\n\n⚠️ *Response was cut short due to an error.*`,
                sources
              );
            }
          }
        }
      },
      cancel() {
        closed = true;
        if (fullResponse) {
          saveChatHistory(chatId, question, stripTacticalJson(fullResponse).trim(), sources);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("[chat] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

function saveChatHistory(
  id: string,
  question: string,
  answer: string,
  sources: string[],
  mapImage?: GeneratedMapImage
) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO chat_history (id, question, answer, sources, language, model)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      question,
      answer,
      JSON.stringify({ sources, mapImage: mapImage || null }),
      detectLang(question),
      LLM_MODEL
    );
  } catch (e) {
    console.warn("[chat] Failed to save chat history:", e);
  }
}

/**
 * Generate a tactical map SVG from TacticalData.
 * Calls the renderer directly (same logic as /api/map-tactics) to avoid
 * an internal HTTP request during streaming.
 */
async function generateTacticalMap(
  tactical: TacticalData
): Promise<GeneratedMapImage | null> {
  try {
    // HIGH-1 fix: Validate map name against allowlist
    const { MAP_NAMES } = await import("@/lib/map-detection");
    const validMapNames: readonly string[] = MAP_NAMES;
    if (!validMapNames.includes(tactical.map)) {
      console.warn(`[chat] Invalid map name rejected: ${tactical.map}`);
      return null;
    }

    // Limit array sizes to prevent DoS
    if (tactical.players.length > 20 || tactical.utility.length > 30 || tactical.arrows.length > 50) {
      console.warn(`[chat] Tactical data too large, truncating`);
      tactical.players = tactical.players.slice(0, 20);
      tactical.utility = tactical.utility.slice(0, 30);
      tactical.arrows = tactical.arrows.slice(0, 50);
    }

    // Try the map renderer module directly (no HTTP self-fetch)
    let svg: string;
    try {
      const renderer = await import("@/lib/map-renderer");
      if (renderer.renderTacticalMap) {
        const rendererOpts = toRendererOptions(tactical);
        svg = renderer.renderTacticalMap(rendererOpts);
      } else {
        throw new Error("renderTacticalMap not exported");
      }
    } catch (rendererErr) {
      console.warn("[chat] map-renderer unavailable, skipping SVG generation:", rendererErr);
      return null;
    }

    const generatedMap = writeGeneratedMapSvg(tactical.map, svg);
    if (!generatedMap) return null;

    return { url: generatedMap.url, map: tactical.map, phases: getPhaseMetadata(tactical) };
  } catch (error) {
    console.error("[chat] Error generating tactical map:", error);
    return null;
  }
}
