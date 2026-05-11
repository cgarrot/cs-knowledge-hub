import { NextRequest, NextResponse } from "next/server";
import { generateEmbedding } from "@/lib/embeddings";
import { findSimilar, getDb } from "@/lib/db";

export const runtime = "nodejs";

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
    const results = database
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

    return NextResponse.json({
      query,
      results: results.map((r) => ({
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
