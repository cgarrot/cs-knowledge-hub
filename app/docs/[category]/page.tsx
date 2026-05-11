import { getCategory, loadCategoryIndex } from "@/lib/categories";
import { getDb } from "@/lib/db";
import Link from "next/link";
import { notFound } from "next/navigation";

interface DocRow {
  slug: string;
  title: string;
  category: string;
}

export default function CategoryPage({ params }: { params: { category: string } }) {
  const category = getCategory(params.category);
  if (!category) notFound();

  // Try to load docs from DB
  let docs: DocRow[] = [];
  try {
    const db = getDb();
    docs = db
      .prepare("SELECT slug, title, category FROM documents WHERE category = ? ORDER BY title")
      .all(params.category) as DocRow[];
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
      </div>

      {/* Documents List */}
      {docs.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {docs.map((doc) => (
            <Link
              key={doc.slug}
              href={`/docs/${params.category}/${doc.slug}`}
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
