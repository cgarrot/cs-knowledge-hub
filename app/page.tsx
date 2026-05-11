import { loadCategoryIndex } from "@/lib/categories";

export default function HomePage() {
  const index = loadCategoryIndex();
  const categories = index.categories;

  return (
    <div className="min-h-screen">
      {/* Hero Section */}
      <section className="relative py-20 px-4 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-accent-purple/5 to-transparent" />
        <div className="max-w-7xl mx-auto relative">
          <h1 className="text-5xl md:text-6xl font-bold text-center mb-6">
            <span className="gradient-text">CS Knowledge Hub</span>
          </h1>
          <p className="text-xl text-gray-400 text-center max-w-2xl mx-auto mb-10">
            Explore computer science topics, search through curated knowledge, and chat with an AI assistant powered by your docs.
          </p>
          <div className="flex items-center justify-center gap-4">
            <a href="/chat" className="btn-primary text-lg">
              💬 Ask the AI
            </a>
            <a href="#categories" className="btn-secondary text-lg">
              📚 Browse Topics
            </a>
          </div>
        </div>
      </section>

      {/* Search Bar */}
      <section className="max-w-3xl mx-auto px-4 -mt-4 mb-12">
        <form action="/api/search" method="get" className="relative">
          <input
            type="text"
            name="q"
            placeholder="Search documents, topics, concepts..."
            className="w-full px-6 py-4 bg-surface-card border border-surface-border rounded-2xl 
                       text-gray-100 placeholder-gray-500 text-lg
                       focus:outline-none focus:border-accent-purple/50 focus:ring-2 focus:ring-accent-purple/20
                       transition-all duration-200"
          />
          <button
            type="submit"
            className="absolute right-3 top-1/2 -translate-y-1/2 px-4 py-2 bg-accent-purple/20 rounded-xl 
                       text-accent-purple-light hover:bg-accent-purple/30 transition-colors"
          >
            🔍
          </button>
        </form>
      </section>

      {/* Categories Grid */}
      <section id="categories" className="max-w-7xl mx-auto px-4 pb-20">
        <h2 className="text-3xl font-bold mb-8 gradient-text">Topics</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {categories.map((cat) => (
            <a
              key={cat.id}
              href={`/docs/${cat.id}`}
              className="card-glow group p-6 bg-surface-card border border-surface-border rounded-xl
                         hover:border-accent-purple/40 transition-all duration-300"
            >
              <div className="text-4xl mb-3">{cat.icon}</div>
              <h3 className="text-lg font-semibold text-gray-100 group-hover:text-accent-purple-light transition-colors">
                {cat.name}
              </h3>
              <p className="text-sm text-gray-500 mt-2 line-clamp-2">
                {cat.description}
              </p>
              <div className="mt-4 text-xs text-accent-purple/70">
                {cat.documentCount} document{cat.documentCount !== 1 ? "s" : ""}
              </div>
            </a>
          ))}
        </div>
      </section>

      {/* Stats Footer */}
      <section className="border-t border-surface-border py-10 px-4">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-center gap-8 text-gray-500">
          <div className="text-center">
            <div className="text-2xl font-bold gradient-text">{index.totalDocuments}</div>
            <div className="text-sm">Documents</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold gradient-text">{categories.length}</div>
            <div className="text-sm">Categories</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold gradient-text">AI</div>
            <div className="text-sm">Powered Chat</div>
          </div>
        </div>
      </section>
    </div>
  );
}
