import { getCategory, loadCategoryIndex } from "@/lib/categories";
import Link from "next/link";
import { notFound } from "next/navigation";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

interface IndexEntry {
  file: string;
  category: string;
  subcategory: string;
  skill_level: string;
  language: string;
  topics: string[];
  summary: string;
}

export default async function CategoryPage({ params }: { params: Promise<{ category: string }> }) {
  const { category: categoryId } = await params;
  const category = getCategory(categoryId);
  if (!category) notFound();

  // Load documents from the full-index.json (not DB)
  const docs: Array<{ file_path: string; title: string; category: string; summary: string; topics: string[] }> = [];
  
  try {
    const indexPath = process.env.CATEGORY_INDEX_PATH || "/app/data/full-index.json";
    if (fs.existsSync(indexPath)) {
      const raw = fs.readFileSync(indexPath, "utf-8");
      const entries: IndexEntry[] = JSON.parse(raw);
      
      for (const entry of entries) {
        if (entry.category === categoryId) {
          const title = entry.file
            .replace(/\.md$/, "")
            .split("/")
            .pop()
            ?.replace(/[-_]/g, " ") || entry.file;
          docs.push({
            file_path: entry.file,
            title,
            category: entry.category,
            summary: entry.summary || "",
            topics: entry.topics || [],
          });
        }
      }
    }
  } catch (e) {
    console.warn("[docs] Failed to load index:", e);
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-10">
      {/* Breadcrumb */}
      <nav className="text-sm text-gray-500 mb-6">
        <Link href="/" className="hover:text-accent-purple-light transition-colors">Home</Link>
        <span className="mx-2">/</span>
        <span className="text-gray-300">{category.name}</span>
      </nav>

      {/* Header */}
      <div className="mb-10">
        <div className="text-5xl mb-4">{category.icon}</div>
        <h1 className="text-4xl font-bold gradient-text mb-3">{category.name}</h1>
        <p className="text-gray-400 text-lg max-w-2xl">{category.description}</p>
        <div className="mt-3 text-sm text-accent-purple/70">
          {docs.length} document{docs.length !== 1 ? "s" : ""} available
        </div>
        {category.subcategories && category.subcategories.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {category.subcategories.map((sub) => (
              <span key={sub} className="px-3 py-1 text-xs bg-surface-card border border-surface-border rounded-full text-gray-400">
                {sub}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Documents List */}
      {docs.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {docs.map((doc) => (
            <Link
              key={doc.file_path}
              href={`/docs/${categoryId}/${encodeURIComponent(doc.file_path)}`}
              className="card-glow p-5 bg-surface-card border border-surface-border rounded-xl
                         hover:border-accent-purple/40 transition-all duration-300 group"
            >
              <h3 className="font-semibold text-gray-200 group-hover:text-accent-purple-light transition-colors">
                {doc.title}
              </h3>
              {doc.summary && (
                <p className="text-sm text-gray-500 mt-1 line-clamp-2">{doc.summary}</p>
              )}
              {doc.topics.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {doc.topics.slice(0, 4).map((t) => (
                    <span key={t} className="text-xs px-2 py-0.5 bg-accent-purple/10 text-accent-purple-light rounded">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </Link>
          ))}
        </div>
      ) : (
        <div className="text-center py-20">
          <div className="text-6xl mb-4">📭</div>
          <h2 className="text-xl font-semibold text-gray-300 mb-2">No documents yet</h2>
          <p className="text-gray-500">
            Documents for this category will appear once the knowledge base is populated.
          </p>
        </div>
      )}
    </div>
  );
}
