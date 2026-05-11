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
      const db = getDb();
      const results = similar.map((s) => {
        const doc = db
          .prepare("SELECT id, slug, title, category FROM documents WHERE id = ?")
          .get(s.document_id) as { id: number; slug: string; title: string; category: string } | undefined;

        return {
          documentId: s.document_id,
          slug: doc?.slug || "",
          title: doc?.title || "Unknown",
          category: doc?.category || "unknown",
          excerpt: s.chunk_text.slice(0, 200),
          score: s.score,
        };
      });

      return NextResponse.json({ query, results, mode: "semantic" });
    }
  } catch (error) {
    console.warn("[search] Semantic search failed, falling back to text search:", error);
  }

  // Fallback: text search in SQLite
  try {
    const db = getDb();
    const results = db
      .prepare(
        `SELECT id, slug, title, category, substr(content, 1, 200) as excerpt 
         FROM documents 
         WHERE title LIKE ? OR content LIKE ?
         ORDER BY title
         LIMIT 20`
      )
      .all(`%${query}%`, `%${query}%`) as Array<{
        id: number;
        slug: string;
        title: string;
        category: string;
        excerpt: string;
      }>;

    return NextResponse.json({
      query,
      results: results.map((r) => ({
        documentId: r.id,
        slug: r.slug,
        title: r.title,
        category: r.category,
        excerpt: r.excerpt,
        score: 1,
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
