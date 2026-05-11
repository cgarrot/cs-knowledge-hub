import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { generateEmbedding } from "@/lib/embeddings";
import { findSimilar, getDb } from "@/lib/db";

export const runtime = "nodejs";

interface IndexEntry {
  file: string;
  category: string;
  subcategory: string;
  skill_level: string;
  language: string;
  topics: string[];
  summary: string;
}

const RAW_DIR =
  process.env.RAW_DIR ||
  path.join(process.env.DATA_DIR || "/data", "sources");

const INDEX_PATH =
  process.env.CATEGORY_INDEX_PATH ||
  path.join(process.env.DATA_DIR || "/data", "categories", "full-index.json");

let fileIndexCache: { map: Map<string, IndexEntry>; timestamp: number } | null = null;

function loadFileIndex(): Map<string, IndexEntry> {
  if (fileIndexCache && Date.now() - fileIndexCache.timestamp < 60_000) {
    return fileIndexCache.map;
  }
  try {
    if (fs.existsSync(INDEX_PATH)) {
      const raw = fs.readFileSync(INDEX_PATH, "utf-8");
      const entries: IndexEntry[] = JSON.parse(raw);
      const map = new Map<string, IndexEntry>();
      for (const entry of entries) {
        map.set(entry.file, entry);
      }
      fileIndexCache = { map, timestamp: Date.now() };
      return map;
    }
  } catch (e) {
    console.warn("[search] Failed to load file index:", e);
  }
  fileIndexCache = { map: new Map(), timestamp: Date.now() };
  return fileIndexCache.map;
}

function searchRawFiles(
  query: string,
  maxResults = 10
): Array<{
  id: number;
  filePath: string;
  title: string;
  category: string | null;
  subcategory: string | null;
  skillLevel: string | null;
  topics: string[];
  summary: string | null;
  excerpt: string;
  score: number;
}> {
  const q = query.toLowerCase();
  const index = loadFileIndex();
  const results: Array<{
    id: number;
    filePath: string;
    title: string;
    category: string | null;
    subcategory: string | null;
    skillLevel: string | null;
    topics: string[];
    summary: string | null;
    excerpt: string;
    score: number;
  }> = [];

  const metaMatches: Array<{ relPath: string; meta: IndexEntry }> = [];
  for (const [relPath, meta] of index) {
    if (
      meta.summary.toLowerCase().includes(q) ||
      meta.topics.some((t) => t.toLowerCase().includes(q)) ||
      meta.category.toLowerCase().includes(q) ||
      relPath.toLowerCase().includes(q)
    ) {
      metaMatches.push({ relPath, meta });
    }
  }

  metaMatches.sort((a, b) => {
    const aTitle = a.relPath.toLowerCase().includes(q) ? 3 : 0;
    const aCat = a.meta.category.toLowerCase().includes(q) ? 2 : 0;
    const aTopic = a.meta.topics.some((t) => t.toLowerCase().includes(q)) ? 1 : 0;
    const aScore = aTitle + aCat + aTopic;

    const bTitle = b.relPath.toLowerCase().includes(q) ? 3 : 0;
    const bCat = b.meta.category.toLowerCase().includes(q) ? 2 : 0;
    const bTopic = b.meta.topics.some((t) => t.toLowerCase().includes(q)) ? 1 : 0;
    const bScore = bTitle + bCat + bTopic;

    return bScore - aScore;
  });

  for (const { relPath, meta } of metaMatches.slice(0, maxResults)) {
    try {
      const fullPath = path.join(RAW_DIR, relPath);
      let content = "";
      if (fs.existsSync(fullPath)) {
        content = fs.readFileSync(fullPath, "utf-8");
      }

      const lowerContent = content.toLowerCase();
      const matchIdx = lowerContent.indexOf(q);
      const excerpt =
        matchIdx >= 0
          ? content.slice(
              Math.max(0, matchIdx - 150),
              Math.min(content.length, matchIdx + q.length + 150)
            )
          : content.slice(0, 300);

      results.push({
        id: -(results.length + 1),
        filePath: relPath,
        title: relPath
          .replace(/\.md$/, "")
          .split("/")
          .pop()
          ?.replace(/[-_]/g, " ") || relPath,
        category: meta.category || null,
        subcategory: meta.subcategory || null,
        skillLevel: meta.skill_level || null,
        topics: meta.topics || [],
        summary: meta.summary || null,
        excerpt: excerpt.trim().slice(0, 300),
        score: 0.5,
      });
    } catch {
      // file not readable — skip
    }
  }

  if (results.length < maxResults && fs.existsSync(RAW_DIR)) {
    const walked: string[] = [];
    function walkDir(dir: string, prefix: string = "") {
      if (walked.length >= maxResults * 2) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (walked.length >= maxResults * 2) return;
        const fullPath = path.join(dir, entry.name);
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walkDir(fullPath, relPath);
        } else if (entry.name.endsWith(".md")) {
          walked.push(relPath);
        }
      }
    }
    walkDir(RAW_DIR);

    for (const relPath of walked) {
      if (results.length >= maxResults) break;
      if (index.has(relPath)) continue;

      try {
        const fullPath = path.join(RAW_DIR, relPath);
        const content = fs.readFileSync(fullPath, "utf-8");
        const lowerContent = content.toLowerCase();
        if (!lowerContent.includes(q)) continue;

        const matchIdx = lowerContent.indexOf(q);
        results.push({
          id: -(results.length + 1),
          filePath: relPath,
          title: relPath
            .replace(/\.md$/, "")
            .split("/")
            .pop()
            ?.replace(/[-_]/g, " ") || relPath,
          category: null,
          subcategory: null,
          skillLevel: null,
          topics: [],
          summary: null,
          excerpt: content.slice(
            Math.max(0, matchIdx - 150),
            Math.min(content.length, matchIdx + q.length + 150)
          ).trim().slice(0, 300),
          score: 0.4,
        });
      } catch {
        // file not readable — skip
      }
    }
  }

  return results.slice(0, maxResults);
}


export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const query = searchParams.get("q");

  if (!query) {
    return NextResponse.json({ error: "Missing query parameter 'q'" }, { status: 400 });
  }

  // Try semantic search with embeddings
  try {
    const queryEmbedding = await generateEmbedding(query);
    const similar = findSimilar(queryEmbedding, 10);

    if (similar.length > 0) {
      const results = similar.map((s) => {
        let topics: string[] = [];
        try {
          topics = s.topics ? JSON.parse(s.topics) : [];
        } catch { /* ignore */ }

        return {
          id: s.id,
          filePath: s.file_path,
          title: s.file_path
            .replace(/\.md$/, "")
            .split("/")
            .pop()
            ?.replace(/[-_]/g, " ") || s.file_path,
          category: s.category,
          subcategory: s.subcategory,
          skillLevel: s.skill_level,
          topics,
          summary: s.summary,
          excerpt: s.chunk_text.slice(0, 300),
          score: Math.round(s.score * 1000) / 1000,
        };
      });

      return NextResponse.json({ query, results, mode: "semantic" });
    }
  } catch (error) {
    console.warn("[search] Semantic search failed, falling back to text search:", error);
  }

  // Fallback: text search in SQLite
  try {
    const database = getDb();
    const dbResults = database
      .prepare(
        `SELECT id, file_path, chunk_text, category, subcategory, skill_level, topics, summary
         FROM chunks 
         WHERE chunk_text LIKE ? OR category LIKE ?
         ORDER BY id
         LIMIT 20`
      )
      .all(`%${query}%`, `%${query}%`) as Array<{
      id: number;
      file_path: string;
      chunk_text: string;
      category: string | null;
      subcategory: string | null;
      skill_level: string | null;
      topics: string | null;
      summary: string | null;
    }>;

    if (dbResults.length > 0) {
      return NextResponse.json({
        query,
        results: dbResults.map((r) => ({
          id: r.id,
          filePath: r.file_path,
          title: r.file_path
            .replace(/\.md$/, "")
            .split("/")
            .pop()
            ?.replace(/[-_]/g, " ") || r.file_path,
          category: r.category,
          subcategory: r.subcategory,
          skillLevel: r.skill_level,
          topics: r.topics ? JSON.parse(r.topics) : [],
          summary: r.summary,
          excerpt: r.chunk_text.slice(0, 300),
          score: 0.5,
        })),
        mode: "text",
      });
    }

    console.log("[search] SQLite empty, falling back to raw file search");
    const fileResults = searchRawFiles(query);
    if (fileResults.length > 0) {
      return NextResponse.json({
        query,
        results: fileResults,
        mode: "text",
      });
    }

    return NextResponse.json({
      query,
      results: [],
      mode: "text",
      message: "No results found - knowledge base may need indexing",
    });
  } catch (error) {
    console.error("[search] Text search also failed:", error);
    return NextResponse.json({
      query,
      results: [],
      mode: "none",
      message: "Search unavailable - knowledge base not yet populated",
    });
  }
}
