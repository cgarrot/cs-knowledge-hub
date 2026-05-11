import { getCategory, loadCategoryIndex } from "@/lib/categories";
import { getDb } from "@/lib/db";
import Link from "next/link";
import { notFound } from "next/navigation";

interface ChunkInfo {
  file_path: string;
  category: string | null;
  summary: string | null;
}

export default function CategoryPage({ params }: { params: { category: string } }) {
  const category = getCategory(params.category);
  if (!category) notFound();

  // Try to load docs from DB using chunks table
  let docs: Array<{ file_path: string; title: string; category: string }> = [];
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT DISTINCT file_path, category FROM chunks WHERE category = ? ORDER BY file_path`
      )
      .all(params.category) as Array<{ file_path: string; category: string | null }>;
    docs = rows.map((r) => ({
      file_path: r.file_path,
      title: r.file_path
        .replace(/\.md$/, "")
        .split("/")
        .pop()
        ?.replace(/[-_]/g, " ") || r.file_path,
      category: r.category || params.category,
    }));
  } catch {
    // DB not populated yet
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
          {category.documentCount} document{category.documentCount !== 1 ? "s" : ""} available
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
              href={`/docs/${params.category}/${encodeURIComponent(doc.file_path)}`}
              className="card-glow p-5 bg-surface-card border border-surface-border rounded-xl
                         hover:border-accent-purple/40 transition-all duration-300 group"
            >
              <h3 className="font-semibold text-gray-200 group-hover:text-accent-purple-light transition-colors">
                {doc.title}
              </h3>
              <p className="text-sm text-gray-500 mt-1">{doc.category}</p>
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

export function generateStaticParams() {
  const index = loadCategoryIndex();
  return index.categories.map((cat) => ({ category: cat.id }));
}
