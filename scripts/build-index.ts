#!/usr/bin/env npx tsx
/**
 * Build the SQLite knowledge base index.
 * Reads full-index.json + raw .md source files, chunks them, generates embeddings, and stores in SQLite.
 *
 * Usage: npx tsx scripts/build-index.ts
 */

import fs from "fs";
import path from "path";
import { generateEmbedding, generateEmbeddingsBatch, chunkText } from "../lib/embeddings";
import { getDb, insertChunk, clearChunks, hasChunks } from "../lib/db";

const RAW_DIR = process.env.RAW_DIR || "/home/ubuntu/cs-knowledge/raw/sources";
const INDEX_PATH =
  process.env.CATEGORY_INDEX_PATH || "/home/ubuntu/cs-knowledge/categories/full-index.json";

interface IndexEntry {
  file: string;
  category: string;
  subcategory: string;
  skill_level: string;
  language: string;
  topics: string[];
  summary: string;
}

interface ChunkData {
  file_path: string;
  chunk_index: number;
  chunk_text: string;
  category?: string;
  subcategory?: string;
  skill_level?: string;
  language?: string;
  topics?: string[];
  summary?: string;
}

async function main() {
  console.log("=== Building Knowledge Base Index ===");
  console.log("Raw dir:", RAW_DIR);
  console.log("Index path:", INDEX_PATH);

  // Load category index
  let indexEntries: IndexEntry[] = [];
  if (fs.existsSync(INDEX_PATH)) {
    indexEntries = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
    console.log(`Loaded ${indexEntries.length} entries from category index`);
  } else {
    console.warn("Category index not found, proceeding without metadata");
  }

  // Build a lookup: file -> IndexEntry
  const indexMap = new Map<string, IndexEntry>();
  for (const entry of indexEntries) {
    indexMap.set(entry.file, entry);
  }

  // Find all .md files
  const allFiles: string[] = [];
  function walkDir(dir: string, prefix: string = "") {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walkDir(fullPath, relPath);
      } else if (entry.name.endsWith(".md")) {
        allFiles.push(relPath);
      }
    }
  }
  walkDir(RAW_DIR);
  console.log(`Found ${allFiles.length} markdown files`);

  // Check if DB already has data
  if (hasChunks()) {
    console.log("Clearing existing chunks for re-index...");
    clearChunks();
  }

  // Process files: read, chunk, collect
  const allChunks: ChunkData[] = [];
  let processed = 0;
  let skipped = 0;

  for (const relPath of allFiles) {
    const fullPath = path.join(RAW_DIR, relPath);
    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      if (content.trim().length < 50) {
        skipped++;
        continue;
      }

      const chunks = chunkText(content, 500, 100);
      const meta = indexMap.get(relPath);

      for (let i = 0; i < chunks.length; i++) {
        allChunks.push({
          file_path: relPath,
          chunk_index: i,
          chunk_text: chunks[i],
          category: meta?.category,
          subcategory: meta?.subcategory,
          skill_level: meta?.skill_level,
          language: meta?.language || "en",
          topics: meta?.topics,
          summary: meta?.summary,
        });
      }

      processed++;
      if (processed % 100 === 0) {
        console.log(`  Processed ${processed}/${allFiles.length} files...`);
      }
    } catch (err) {
      console.warn(`  Error reading ${relPath}:`, err);
      skipped++;
    }
  }

  console.log(`Processed: ${processed}, Skipped: ${skipped}, Total chunks: ${allChunks.length}`);

  // Generate embeddings in batches and insert
  console.log("Generating embeddings...");
  const BATCH_SIZE = 8;
  let embedded = 0;

  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((c) => c.chunk_text);

    try {
      const embeddings = await generateEmbeddingsBatch(texts);

      for (let j = 0; j < batch.length; j++) {
        insertChunk({
          ...batch[j],
          embedding: embeddings[j],
        });
      }

      embedded += batch.length;
      if (embedded % 100 === 0 || embedded === allChunks.length) {
        console.log(`  Embedded ${embedded}/${allChunks.length} chunks...`);
      }
    } catch (err) {
      console.error(`  Error embedding batch at ${i}:`, err);
      // Insert with zero embeddings as fallback
      for (const chunk of batch) {
        insertChunk({
          ...chunk,
          embedding: new Array(384).fill(0),
        });
      }
      embedded += batch.length;
    }
  }

  console.log(`\n=== Index build complete ===`);
  console.log(`Total chunks in DB: ${embedded}`);

  // Close DB
  const database = getDb();
  database.close();
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
