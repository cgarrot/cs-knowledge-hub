import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CS Knowledge Hub",
  description: "Your comprehensive computer science knowledge base with AI-powered chat",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="bg-surface text-gray-100 antialiased">
        <nav className="border-b border-surface-border bg-surface/80 backdrop-blur-md sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between h-16">
              <a href="/" className="flex items-center gap-3">
                <span className="text-2xl">🧠</span>
                <span className="text-xl font-bold bg-gradient-to-r from-accent-purple to-accent-orange bg-clip-text text-transparent">
                  CS Knowledge Hub
                </span>
              </a>
              <div className="flex items-center gap-6">
                <a href="/" className="text-gray-300 hover:text-accent-purple transition-colors">
                  Explore
                </a>
                <a href="/chat" className="px-4 py-2 bg-accent-purple/20 border border-accent-purple/50 rounded-lg text-accent-purple-light hover:bg-accent-purple/30 transition-all">
                  💬 Chat
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
