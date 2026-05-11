import { NextRequest, NextResponse } from "next/server";
import { buildRAGPrompt, streamChat, type ChatMessage } from "@/lib/llm";
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

function searchRelevantDocs(query: string, maxResults = 8): string {
  const q = query.toLowerCase();
  const entries = loadFileIndex();

  // Score each entry by relevance
  const scored: Array<{ entry: IndexEntry; score: number }> = [];
  for (const entry of entries) {
    let score = 0;
    const lowerSummary = entry.summary.toLowerCase();
    const lowerTopics = entry.topics.map(t => t.toLowerCase());
    const lowerCategory = entry.category.toLowerCase();
    const lowerFile = entry.file.toLowerCase();

    // Check summary match
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

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  const topResults = scored.slice(0, maxResults);

  if (topResults.length === 0) {
    return "";
  }

  // Build context from top results, reading actual file content
  const contextParts: string[] = [];
  for (const { entry, score } of topResults) {
    const fullPath = path.join(RAW_DIR, entry.file);
    let content = "";
    try {
      if (fs.existsSync(fullPath)) {
        content = fs.readFileSync(fullPath, "utf-8");
        // Truncate to first 2000 chars to avoid overwhelming context
        if (content.length > 2000) {
          content = content.slice(0, 2000) + "\n...[truncated]";
        }
      }
    } catch {
      // File not readable, use summary only
    }

    const meta = [
      entry.category ? `Category: ${entry.category}` : "",
      entry.subcategory ? `Sub: ${entry.subcategory}` : "",
      entry.skill_level ? `Level: ${entry.skill_level}` : "",
    ].filter(Boolean).join(" | ");

    contextParts.push(
      `[Source: ${entry.file} (${meta}) - Relevance: ${score}]\n${content || entry.summary}`
    );
  }

  return contextParts.join("\n\n---\n\n");
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

    // Search relevant docs using raw file index (no DB needed)
    const context = searchRelevantDocs(lastMessage.content, 8);

    // Build messages for LLM
    const systemMessage: ChatMessage = {
      role: "system",
      content: buildRAGPrompt(context || "No specific documents found, answer from general CS2 knowledge."),
    };

    const llmMessages: ChatMessage[] = [systemMessage, ...messages];

    // Stream response
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of streamChat(llmMessages)) {
            const data = JSON.stringify({ content: chunk });
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (error) {
          console.error("[chat] Stream error:", error);
          const errorData = JSON.stringify({
            content: "An error occurred during streaming.",
          });
          controller.enqueue(encoder.encode(`data: ${errorData}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
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
