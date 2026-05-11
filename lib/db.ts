import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { embeddingToBuffer, bufferToEmbedding } from "./embeddings";

const DB_PATH =
  process.env.DB_PATH || path.join(process.env.DATA_DIR || "./data", "knowledge.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  // Ensure directory exists
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Create tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      embedding BLOB,
      category TEXT,
      subcategory TEXT,
      skill_level TEXT,
      language TEXT DEFAULT 'en',
      topics TEXT,
      summary TEXT,
      metadata TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);
    CREATE INDEX IF NOT EXISTS idx_chunks_category ON chunks(category);
  `);

  return db;
}

/** Row shape for a chunk */
export interface ChunkRow {
  id: number;
  file_path: string;
  chunk_index: number;
  chunk_text: string;
  embedding: Buffer | null;
  category: string | null;
  subcategory: string | null;
  skill_level: string | null;
  language: string | null;
  topics: string | null;
  summary: string | null;
  metadata: string | null;
}

/** Insert a chunk with its embedding and metadata */
export function insertChunk(chunk: {
  file_path: string;
  chunk_index: number;
  chunk_text: string;
  embedding: number[];
  category?: string;
  subcategory?: string;
  skill_level?: string;
  language?: string;
  topics?: string[];
  summary?: string;
  metadata?: Record<string, unknown>;
}): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO chunks (file_path, chunk_index, chunk_text, embedding, category, subcategory, skill_level, language, topics, summary, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    chunk.file_path,
    chunk.chunk_index,
    chunk.chunk_text,
    embeddingToBuffer(chunk.embedding),
    chunk.category || null,
    chunk.subcategory || null,
    chunk.skill_level || null,
    chunk.language || "en",
    chunk.topics ? JSON.stringify(chunk.topics) : null,
    chunk.summary || null,
    chunk.metadata ? JSON.stringify(chunk.metadata) : null
  );
}

/** Helper: cosine similarity between two vectors */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Find most similar chunks by embedding vector */
export function findSimilar(
  embedding: number[],
  topK = 5
): Array<{
  id: number;
  file_path: string;
  chunk_text: string;
  category: string | null;
  subcategory: string | null;
  skill_level: string | null;
  topics: string | null;
  summary: string | null;
  score: number;
}> {
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT id, file_path, chunk_text, embedding, category, subcategory, skill_level, topics, summary
       FROM chunks`
    )
    .all() as Array<{
    id: number;
    file_path: string;
    chunk_text: string;
    embedding: Buffer | null;
    category: string | null;
    subcategory: string | null;
    skill_level: string | null;
    topics: string | null;
    summary: string | null;
  }>;

  const scored = rows
    .map((row) => {
      if (!row.embedding) return null;
      const vec = bufferToEmbedding(row.embedding);
      return {
        id: row.id,
        file_path: row.file_path,
        chunk_text: row.chunk_text,
        category: row.category,
        subcategory: row.subcategory,
        skill_level: row.skill_level,
        topics: row.topics,
        summary: row.summary,
        score: cosineSimilarity(embedding, vec),
      };
    })
    .filter(Boolean) as Array<{
    id: number;
    file_path: string;
    chunk_text: string;
    category: string | null;
    subcategory: string | null;
    skill_level: string | null;
    topics: string | null;
    summary: string | null;
    score: number;
  }>;

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/** Check if the DB already has chunks */
export function hasChunks(): boolean {
  const database = getDb();
  const count = database.prepare("SELECT COUNT(*) as c FROM chunks").get() as {
    c: number;
  };
  return count.c > 0;
}

/** Clear all chunks (for reindexing) */
export function clearChunks(): void {
  const database = getDb();
  database.exec("DELETE FROM chunks");
}

/** Graceful shutdown */
process.on("SIGINT", () => {
  if (db) db.close();
  process.exit(0);
});
