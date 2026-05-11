import { getCategory } from "@/lib/categories";
import Link from "next/link";
import { notFound } from "next/navigation";
import fs from "fs";
import path from "path";

const RAW_DIR = process.env.RAW_DIR || path.join(process.env.DATA_DIR || "/data", "sources");

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ category: string; slug: string[] }>;
}

export default async function DocPage({ params }: PageProps) {
  const { category: categorySlug, slug: slugParts } = await params;
  const category = getCategory(categorySlug);
  if (!category) notFound();

  // Reconstruct the file path from slug segments
  const filePath = slugParts.map(decodeURIComponent).join("/");

  // Try reading from file system
  let content = "";
  let docTitle = filePath.split("/").pop()?.replace(/[-_]/g, " ").replace(/\.md$/, "") || filePath;
  const fullPath = path.join(RAW_DIR, filePath);

  try {
    if (fs.existsSync(fullPath)) {
      content = fs.readFileSync(fullPath, "utf-8");

      // Try to extract title from first H1 or frontmatter
      const h1Match = content.match(/^#\s+(.+)$/m);
      if (h1Match) {
        docTitle = h1Match[1].trim();
      }

      // Strip frontmatter
      if (content.startsWith("---")) {
        const endFm = content.indexOf("---", 3);
        if (endFm > 0) {
          content = content.slice(endFm + 3).trim();
        }
      }
    }
  } catch {
    // File not readable
  }

  // Also try loading from DB (chunks table)
  let dbContent = "";
  let meta: { category?: string; subcategory?: string; skill_level?: string; topics?: string } | null = null;
  try {
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT chunk_text, category, subcategory, skill_level, topics FROM chunks WHERE file_path = ? ORDER BY chunk_index`
      )
      .all(filePath) as Array<{
        chunk_text: string;
        category: string | null;
        subcategory: string | null;
        skill_level: string | null;
        topics: string | null;
      }>;

    if (rows.length > 0) {
      dbContent = rows.map((r) => r.chunk_text).join("\n\n");
      meta = {
        category: rows[0].category || undefined,
        subcategory: rows[0].subcategory || undefined,
        skill_level: rows[0].skill_level || undefined,
        topics: rows[0].topics || undefined,
      };
    }
  } catch {
    // DB not available
  }

  // Prefer file content, fallback to DB content
  const displayContent = content || dbContent;

  if (!displayContent) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-10">
        <nav className="text-sm text-gray-500 mb-6">
          <Link href="/" className="hover:text-accent-purple-light transition-colors">Home</Link>
          <span className="mx-2">/</span>
          <Link href={`/docs/${categorySlug}`} className="hover:text-accent-purple-light transition-colors">
            {category.name}
          </Link>
          <span className="mx-2">/</span>
          <span className="text-gray-300">{docTitle}</span>
        </nav>
        <div className="text-center py-20">
          <div className="text-6xl mb-4">📄</div>
          <h2 className="text-xl font-semibold text-gray-300 mb-2">Document not found</h2>
          <p className="text-gray-500 mb-6">
            Could not find this document in the knowledge base.
          </p>
          <Link href={`/docs/${categorySlug}`} className="btn-primary">
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
        <Link href={`/docs/${categorySlug}`} className="hover:text-accent-purple-light transition-colors">
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
            <span>📂 {category.name}</span>
          </div>
        </header>

        <div className="prose prose-invert prose-purple max-w-none">
          <div className="whitespace-pre-wrap text-gray-300 leading-relaxed">
            {displayContent}
          </div>
        </div>
      </article>

      {/* Chat with doc */}
      <div className="mt-8 text-center">
        <Link
          href={`/chat?q=Tell me about ${encodeURIComponent(docTitle)}`}
          className="btn-primary"
        >
          💬 Ask AI about this topic
        </Link>
      </div>
    </div>
  );
}
