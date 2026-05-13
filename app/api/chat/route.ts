import { NextRequest, NextResponse } from "next/server";
import { buildRAGPrompt, streamChat, type ChatMessage } from "@/lib/llm";
import { getDb } from "@/lib/db";
import {
  detectMapMention,
  parseTacticalJSON,
  extractTacticalFromText,
  getDefaultTactical,
  toRendererOptions,
  type TacticalData,
} from "@/lib/map-detection";
import fs from "fs";
import path from "path";

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

const RAW_DIR = process.env.RAW_DIR || path.join(process.env.DATA_DIR || "/data", "sources");
const INDEX_PATH = process.env.CATEGORY_INDEX_PATH || path.join(process.env.DATA_DIR || "/data", "full-index.json");
const LLM_MODEL = process.env.LLM_MODEL || "deepseek-v4-flash";

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
    } catch {}

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

interface ChatRequestBody {
  messages: ChatMessage[];
}

export async function POST(request: NextRequest) {
  try {
    const body: ChatRequestBody = await request.json();
    const { messages } = body;

    if (!messages || messages.length === 0) {
      return NextResponse.json({ error: "No messages provided" }, { status: 400 });
    }

    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role !== "user") {
      return NextResponse.json({ error: "Last message must be from user" }, { status: 400 });
    }

    const question = lastMessage.content;
    const { context, sources } = searchRelevantDocs(question, 8);

    // Detect map mention BEFORE streaming so we can use it for fallback extraction
    const detectedMap = detectMapMention(question);

    const systemMessage: ChatMessage = {
      role: "system",
      content: buildRAGPrompt(context || "No specific documents found, answer from general CS2 knowledge.", question),
    };

    const llmMessages: ChatMessage[] = [systemMessage, ...messages];

    let fullResponse = "";
    const chatId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const encoder = new TextEncoder();
    let closed = false;

    // Start map generation IN PARALLEL as soon as we know the map
    // Send mapImage event mid-stream as soon as SVG is ready
    let mapGenerationPromise: Promise<{ url: string; map: string } | null> | null = null;
    let mapSent = false;
    if (detectedMap) {
      console.log(`[chat] Map detected: ${detectedMap}, starting parallel map generation`);
      mapGenerationPromise = generateTacticalMap(
        getDefaultTactical(detectedMap, question) || {
          map: detectedMap,
          side: "T",
          strategy: "Default positions",
          players: [],
          utility: [],
          arrows: [],
        }
      ).catch((err) => {
        console.warn("[chat] Parallel map generation failed:", err);
        return null;
      });
    }

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of streamChat(llmMessages)) {
            if (closed) return;
            fullResponse += chunk;
            const data = JSON.stringify({ content: chunk });
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));

            // Check if parallel map generation finished — send mapImage during stream
            if (mapGenerationPromise && !mapSent) {
              // Quick check without blocking (Promise.race with immediate resolve)
              const quickResult = await Promise.race([
                mapGenerationPromise.then(r => r),
                Promise.resolve(null as { url: string; map: string } | null)
              ]);
              if (quickResult) {
                mapSent = true;
                console.log("[chat] Sending parallel map image mid-stream");
                const mapData = JSON.stringify({ mapImage: quickResult });
                controller.enqueue(encoder.encode(`data: ${mapData}\n\n`));
              }
            }
          }
          if (!closed) {
            // After streaming completes, try to get a BETTER map from the full response
            let betterMapImage: { url: string; map: string } | undefined;
            try {
              let tactical = parseTacticalJSON(fullResponse);

              // FALLBACK 1: If LLM didn't include tactical JSON, try extracting from text
              if (!tactical && detectedMap) {
                console.log(`[chat] No tactical JSON found, trying text extraction for map: ${detectedMap}`);
                const extracted = extractTacticalFromText(fullResponse, detectedMap);
                if (extracted) {
                  console.log(`[chat] Text extraction succeeded: ${extracted.players.length} players, ${extracted.utility.length} utility, ${extracted.arrows.length} arrows`);
                  tactical = extracted;
                }
              }

              // FALLBACK 2: If text extraction also failed, use deterministic defaults
              if (!tactical && detectedMap) {
                console.log(`[chat] Text extraction failed, using default tactical for map: ${detectedMap}`);
                tactical = getDefaultTactical(detectedMap, fullResponse);
              }

              if (tactical) {
                const result = await generateTacticalMap(tactical);
                if (result) {
                  betterMapImage = result;
                }
              }
            } catch (mapError) {
              console.warn("[chat] Failed to generate tactical map from stream response:", mapError);
            }

            // If we got a better map from the full response AND didn't send one early, send it now
            // If we already sent the early map, skip (don't send duplicate)
            if (betterMapImage && !mapSent) {
              const mapData = JSON.stringify({ mapImage: betterMapImage });
              controller.enqueue(encoder.encode(`data: ${mapData}\n\n`));
              mapSent = true;
            }

            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            closed = true;

            // Save to DB
            saveChatHistory(chatId, question, fullResponse, sources, betterMapImage);
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
            } catch {}
            controller.close();
            closed = true;

            if (fullResponse) {
              saveChatHistory(chatId, question, fullResponse + "\n\n⚠️ *Response was cut short due to an error.*", sources);
            }
          }
        }
      },
      cancel() {
        closed = true;
        if (fullResponse) {
          saveChatHistory(chatId, question, fullResponse, sources);
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
  mapImage?: { url: string; map: string }
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
): Promise<{ url: string; map: string } | null> {
  try {
    // HIGH-1 fix: Validate map name against allowlist
    const { MAP_NAMES } = await import("@/lib/map-detection");
    if (!MAP_NAMES.includes(tactical.map as any)) {
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

    const outputDir = path.join(process.cwd(), "public", "generated-maps");
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
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

    // Save the SVG with sanitized filename
    const timestamp = Date.now();
    const safeMapName = tactical.map.replace(/[^a-z0-9]/g, "");
    const filename = `${safeMapName}-${timestamp}.svg`;
    const filePath = path.join(outputDir, filename);
    fs.writeFileSync(filePath, svg, "utf-8");

    return { url: `/api/generated-maps/${filename}`, map: tactical.map };
  } catch (error) {
    console.error("[chat] Error generating tactical map:", error);
    return null;
  }
}
