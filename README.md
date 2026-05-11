# CS Knowledge Hub

A comprehensive computer science knowledge base with AI-powered chat, built with Next.js and RAG.

## Features

- **Category Browser** — Explore CS topics organized by category
- **Semantic Search** — Find documents using vector similarity search
- **AI Chat** — Ask questions with RAG-powered streaming responses
- **Dark Theme** — Gaming-inspired UI with purple/orange accents

## Tech Stack

- Next.js 14+ (App Router)
- TypeScript
- TailwindCSS (dark theme)
- SQLite + better-sqlite3
- Ollama Cloud (LLM)
- SSE Streaming

## Getting Started

```bash
# Install dependencies
npm install

# Copy environment config
cp .env.example .env.local

# Run development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Project Structure

```
app/
├── page.tsx                    # Homepage with category grid & search
├── chat/page.tsx               # ChatGPT-like interface
├── docs/[category]/page.tsx    # Category page listing docs
├── docs/[category]/[slug]/     # Individual doc page
├── api/chat/route.ts           # RAG endpoint with streaming
├── api/search/route.ts         # Search endpoint
└── ...
lib/
├── db.ts                       # SQLite connection & vector search
├── embeddings.ts               # Embedding generation
├── llm.ts                      # Ollama Cloud integration
└── categories.ts               # Category index loader
```

## Deployment

Deployed via Dokploy on VPS with domain `cs-knowledge.zob.wtf`.

- Build: nixpacks
- Port: 3000
- Volume: `/data` (SQLite persistence)

## Data Pipeline

1. Raw `.md` files in `/home/ubuntu/cs-knowledge/raw/sources/`
2. Category index at `/home/ubuntu/cs-knowledge/categories/full-index.json`
3. Embeddings & docs loaded into SQLite separately
