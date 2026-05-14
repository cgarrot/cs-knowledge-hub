import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CS Knowledge Hub",
  description: "Counter-Strike 2 strategy knowledge base with AI-powered tactical chat",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="bg-surface text-gray-100 antialiased min-h-screen">
        <nav className="border-b border-surface-border bg-[#0a0d12]/90 backdrop-blur-md sticky top-0 z-50 shadow-[inset_0_-1px_0_0_rgba(222,155,53,0.12)]">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between h-16">
              <a href="/" className="flex items-center gap-3 group">
                <span
                  aria-hidden
                  className="flex h-10 w-10 items-center justify-center rounded border border-accent-purple/40 bg-gradient-to-br from-accent-purple/20 to-transparent text-lg font-black italic text-accent-purple-light shadow-[0_0_20px_rgba(222,155,53,0.2)] transition-shadow group-hover:shadow-[0_0_28px_rgba(222,155,53,0.35)]"
                >
                  CS2
                </span>
                <div className="flex flex-col leading-tight">
                  <span className="text-lg font-black uppercase tracking-wide text-gray-100">
                    CS2
                  </span>
                  <span className="text-[10px] font-semibold uppercase tracking-[0.28em] text-gray-500">
                    Knowledge Hub
                  </span>
                </div>
              </a>
              <div className="flex items-center gap-2 sm:gap-6">
                <a
                  href="/"
                  className="text-xs sm:text-sm font-semibold uppercase tracking-wider text-gray-400 hover:text-accent-purple-light transition-colors border-b-2 border-transparent hover:border-accent-purple pb-0.5"
                >
                  Explore
                </a>
                <a
                  href="/chat"
                  className="px-3 py-2 sm:px-4 text-xs sm:text-sm font-bold uppercase tracking-wide bg-accent-purple/15 border border-accent-purple/45 rounded-md text-accent-purple-light hover:bg-accent-purple/25 hover:border-accent-purple/70 transition-all shadow-[0_0_16px_rgba(222,155,53,0.12)]"
                >
                  Chat
                </a>
              </div>
            </div>
          </div>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
