import { getDb } from "@/lib/db";
import { getCategory } from "@/lib/categories";
import Link from "next/link";
import { notFound } from "next/navigation";

interface ChunkRow {
  chunk_text: string;
  category: string | null;
  subcategory: string | null;
  skill_level: string | null;
  topics: string | null;
  summary: string | null;
}

export default function DocPage({
  params,
}: {
  params: { category: string; slug: string };
}) {
  const category = getCategory(params.category);
  if (!category) notFound();

  // The slug is the file_path (URL-encoded)
  const filePath = decodeURIComponent(params.slug);

  // Try to load doc from DB using chunks table
  let chunks: ChunkRow[] = [];
  let docTitle = filePath.split("/").pop()?.replace(/[-_]/g, " ").replace(/\.md$/, "") || filePath;
  try {
    const db = getDb();
    chunks = db
      .prepare(
        `SELECT chunk_text, category, subcategory, skill_level, topics, summary FROM chunks WHERE file_path = ? ORDER BY chunk_index`
      )
      .all(filePath) as ChunkRow[];
    
    // Use summary from first chunk if available
    if (chunks.length > 0 && chunks[0].summary) {
      docTitle = chunks[0].summary.split(".")[0] || docTitle;
    }
  } catch {
    // DB not populated yet
  }

  const content = chunks.map((c) => c.chunk_text).join("\n\n");
  const meta = chunks[0];

  if (chunks.length === 0) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-10">
        <nav className="text-sm text-gray-500 mb-6">
          <Link href="/" className="hover:text-accent-purple-light transition-colors">Home</Link>
          <span className="mx-2">/</span>
          <Link href={`/docs/${params.category}`} className="hover:text-accent-purple-light transition-colors">
            {category.name}
          </Link>
          <span className="mx-2">/</span>
          <span className="text-gray-300">{params.slug}</span>
        </nav>
        <div className="text-center py-20">
          <div className="text-6xl mb-4">📄</div>
          <h2 className="text-xl font-semibold text-gray-300 mb-2">Document not found</h2>
          <p className="text-gray-500 mb-6">
            This document will be available once the knowledge base is populated.
          </p>
          <Link
            href={`/docs/${params.category}`}
            className="btn-primary"
          >
            Back to {category.name}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-10">
      {/* Breadcrumb */}
      <nav className="text-sm text-gray-500 mb-6">
        <Link href="/" className="hover:text-accent-purple-light transition-colors">Home</Link>
        <span className="mx-2">/</span>
        <Link href={`/docs/${params.category}`} className="hover:text-accent-purple-light transition-colors">
          {category.name}
        </Link>
        <span className="mx-2">/</span>
        <span className="text-gray-300">{docTitle}</span>
      </nav>

      {/* Document */}
      <article className="bg-surface-card border border-surface-border rounded-2xl p-8">
        <header className="mb-8">
          <h1 className="text-3xl font-bold gradient-text mb-2">{docTitle}</h1>
          <div className="flex gap-4 text-sm text-gray-500 flex-wrap">
            {meta?.category && <span>📂 {meta.category}</span>}
            {meta?.subcategory && <span>📁 {meta.subcategory}</span>}
            {meta?.skill_level && <span>📊 {meta.skill_level}</span>}
            {meta?.topics && (
              <span>🏷️ {JSON.parse(meta.topics).slice(0, 3).join(", ")}</span>
            )}
          </div>
        </header>

        <div className="prose prose-invert prose-purple max-w-none">
          <div className="whitespace-pre-wrap text-gray-300 leading-relaxed">
            {content}
          </div>
        </div>
      </article>

      {/* Chat with doc */}
      <div className="mt-8 text-center">
        <Link
          href={`/chat?q=Tell me about ${docTitle}`}
          className="btn-primary"
        >
          💬 Ask AI about this topic
        </Link>
      </div>
    </div>
  );
}
