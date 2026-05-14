import { loadCategoryIndex } from "@/lib/categories";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const index = loadCategoryIndex();
  const categories = index.categories;

  return (
    <div className="min-h-screen">
      {/* Hero Section */}
      <section className="relative py-16 md:py-24 px-4 overflow-hidden">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute inset-0 bg-gradient-to-b from-accent-purple/[0.07] via-transparent to-transparent animate-pulse-slow" />
          <div
            className="absolute -top-32 left-1/2 h-64 w-[120%] -translate-x-1/2 rounded-full blur-3xl opacity-50"
            style={{
              background:
                "radial-gradient(ellipse at center, rgba(255, 152, 0, 0.12) 0%, transparent 55%)",
            }}
          />
        </div>
        <div className="max-w-7xl mx-auto relative">
          <p className="text-center text-[11px] font-bold uppercase tracking-[0.35em] text-accent-purple/90 mb-4">
            Operative intel
          </p>
          <h1 className="text-4xl sm:text-5xl md:text-7xl font-black text-center mb-5 uppercase tracking-tight leading-[1.05]">
            <span className="gradient-text drop-shadow-sm">Master CS2 Strategy</span>
          </h1>
          <p className="text-lg md:text-xl text-gray-400 text-center max-w-2xl mx-auto mb-10 leading-relaxed">
            Search curated CS2 tactics, maps, and pro fundamentals — then brief with AI on top of your
            knowledge base.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <a href="/chat" className="btn-primary text-lg w-full sm:w-auto text-center">
              Ask the AI
            </a>
            <a href="#categories" className="btn-secondary text-lg w-full sm:w-auto text-center">
              Browse topics
            </a>
          </div>
        </div>
      </section>

      {/* Search Bar */}
      <section className="max-w-3xl mx-auto px-4 -mt-2 mb-12">
        <form action="/chat" method="get" className="relative">
          <input
            type="text"
            name="q"
            placeholder="Search strategy, maps, economy, utility..."
            className="w-full px-6 py-4 bg-[#0a0d12]/90 border border-surface-border rounded-2xl 
                       text-gray-100 placeholder-gray-500 text-lg shadow-inner
                       focus:outline-none focus:border-accent-purple/55 focus:ring-2 focus:ring-accent-purple/25
                       transition-all duration-200"
          />
          <button
            type="submit"
            className="absolute right-3 top-1/2 -translate-y-1/2 px-4 py-2 bg-accent-purple/25 rounded-xl 
                       text-accent-purple-light border border-accent-purple/35 hover:bg-accent-purple/35 transition-colors font-semibold"
          >
            Ask AI
          </button>
        </form>
      </section>

      {/* Categories Grid */}
      <section id="categories" className="max-w-7xl mx-auto px-4 pb-20">
        <h2 className="text-2xl md:text-3xl font-bold mb-2 uppercase tracking-wide text-gray-200">
          Topics
        </h2>
        <p className="text-sm text-gray-500 mb-8 font-medium uppercase tracking-wider">
          Documentation sectors
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {categories.map((cat) => (
            <a
              key={cat.id}
              href={`/docs/${cat.id}`}
              className="card-glow group p-6 bg-surface-card/85 backdrop-blur-sm border border-surface-border rounded-xl
                         hover:border-accent-purple/45 shadow-lg shadow-black/20 transition-all duration-300"
            >
              <div className="text-4xl mb-3">{cat.icon}</div>
              <h3 className="text-lg font-semibold text-gray-100 group-hover:text-accent-purple-light transition-colors">
                {cat.name}
              </h3>
              <p className="text-sm text-gray-500 mt-2 line-clamp-2">{cat.description}</p>
              <div className="mt-4 text-[11px] font-bold uppercase tracking-wider text-accent-purple/80">
                {cat.documentCount} file{cat.documentCount !== 1 ? "s" : ""}
              </div>
            </a>
          ))}
        </div>
      </section>

      {/* Stats Footer */}
      <section className="border-t border-surface-border py-12 px-4 bg-[#0a0d12]/50">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-center gap-10 md:gap-16">
          <div className="text-center">
            <div className="text-3xl font-black gradient-text tabular-nums">{index.totalDocuments}</div>
            <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.2em] text-gray-500">
              Intel docs
            </div>
          </div>
          <div className="text-center">
            <div className="text-3xl font-black gradient-text tabular-nums">{categories.length}</div>
            <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.2em] text-gray-500">
              Sectors
            </div>
          </div>
          <div className="text-center">
            <div className="text-3xl font-black gradient-text">RAG</div>
            <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.2em] text-gray-500">
              Tactical chat
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
