import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_PATH = process.env.DB_PATH || path.join(process.env.DATA_DIR || "/data", "cs-knowledge.db");

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
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      file_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      embedding BLOB,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category);
    CREATE INDEX IF NOT EXISTS idx_documents_slug ON documents(slug);
    CREATE INDEX IF NOT EXISTS idx_embeddings_document_id ON embeddings(document_id);
  `);

  return db;
}

// Helper: cosine similarity between two vectors
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Helper: find most similar documents by embedding
export function findSimilar(embedding: number[], topK = 5): Array<{ document_id: number; chunk_text: string; score: number }> {
  const database = getDb();
  const rows = database.prepare(`
    SELECT e.document_id, e.chunk_text, e.embedding
    FROM embeddings e
  `).all() as Array<{ document_id: number; chunk_text: string; embedding: Buffer | null }>;

  const scored = rows
    .map((row) => {
      if (!row.embedding) return null;
      const vec = Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));
      return {
        document_id: row.document_id,
        chunk_text: row.chunk_text,
        score: cosineSimilarity(embedding, vec),
      };
    })
    .filter(Boolean) as Array<{ document_id: number; chunk_text: string; score: number }>;

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// Graceful shutdown
process.on("SIGINT", () => {
  if (db) db.close();
  process.exit(0);
});
