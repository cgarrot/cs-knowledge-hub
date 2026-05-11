import { getDb } from "@/lib/db";
import { getCategory } from "@/lib/categories";
import Link from "next/link";
import { notFound } from "next/navigation";

interface DocDetail {
  id: number;
  slug: string;
  title: string;
  category: string;
  content: string;
  file_path: string | null;
  created_at: string;
  updated_at: string;
}

export default function DocPage({
  params,
}: {
  params: { category: string; slug: string };
}) {
  const category = getCategory(params.category);
  if (!category) notFound();

  // Try to load doc from DB
  let doc: DocDetail | null = null;
  try {
    const db = getDb();
    doc = db
      .prepare("SELECT * FROM documents WHERE slug = ? AND category = ?")
      .get(params.slug, params.category) as DocDetail | null;
  } catch {
    // DB not populated yet
  }

  if (!doc) {
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
        <span className="text-gray-300">{doc.title}</span>
      </nav>

      {/* Document */}
      <article className="bg-surface-card border border-surface-border rounded-2xl p-8">
        <header className="mb-8">
          <h1 className="text-3xl font-bold gradient-text mb-2">{doc.title}</h1>
          <div className="flex gap-4 text-sm text-gray-500">
            <span>📂 {doc.category}</span>
            {doc.file_path && <span>📁 {doc.file_path}</span>}
            <span>🕐 {new Date(doc.updated_at).toLocaleDateString()}</span>
          </div>
        </header>

        <div className="prose prose-invert prose-purple max-w-none">
          <div className="whitespace-pre-wrap text-gray-300 leading-relaxed">
            {doc.content}
          </div>
        </div>
      </article>

      {/* Chat with doc */}
      <div className="mt-8 text-center">
        <Link
          href={`/chat?q=Tell me about ${doc.title}`}
          className="btn-primary"
        >
          💬 Ask AI about this topic
        </Link>
      </div>
    </div>
  );
}
