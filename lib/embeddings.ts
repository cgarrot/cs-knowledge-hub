/**
 * Embedding generation using @huggingface/transformers (local, no API needed).
 * Uses all-MiniLM-L6-v2 (384-dim) for fast, high-quality sentence embeddings.
 */

import { pipeline } from "@huggingface/transformers";

const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIM = 384;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let embedder: any = null;

/**
 * Initialize the embedding pipeline (lazy, cached).
 */
async function getEmbedder(): Promise<any> {
  if (embedder) return embedder;
  console.log("[embeddings] Loading model:", EMBEDDING_MODEL);
  embedder = await pipeline("feature-extraction", EMBEDDING_MODEL, {
    dtype: "fp32",
  });
  console.log("[embeddings] Model loaded");
  return embedder;
}

/**
 * Generate a normalized embedding vector for the given text.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const pipe = await getEmbedder();
    const output = await pipe(text, { pooling: "mean", normalize: true });
    return Array.from(output.data as Float32Array);
  } catch (error) {
    console.error("[embeddings] Error generating embedding:", error);
    // Return zero vector as fallback so the system doesn't crash
    return new Array(EMBEDDING_DIM).fill(0);
  }
}

/**
 * Generate embeddings for multiple texts in batch.
 */
export async function generateEmbeddingsBatch(
  texts: string[]
): Promise<number[][]> {
  try {
    const pipe = await getEmbedder();
    const results: number[][] = [];
    // Process in batches of 8 to avoid memory issues
    const BATCH_SIZE = 8;
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const outputs = await Promise.all(
        batch.map((t) => pipe(t, { pooling: "mean", normalize: true }))
      );
      results.push(...outputs.map((o) => Array.from(o.data as Float32Array)));
    }
    return results;
  } catch (error) {
    console.error("[embeddings] Error in batch embedding:", error);
    return texts.map(() => new Array(EMBEDDING_DIM).fill(0));
  }
}

/**
 * Chunk text into pieces of roughly `chunkSize` tokens.
 * Uses a sentence-aware splitting strategy with overlap.
 * Approximate: 1 token ~ 4 chars for English text.
 */
export function chunkText(
  text: string,
  chunkSize = 500,
  overlap = 100
): string[] {
  const CHAR_PER_TOKEN = 4;
  const maxChars = chunkSize * CHAR_PER_TOKEN;
  const overlapChars = overlap * CHAR_PER_TOKEN;

  // Split into paragraphs first
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let currentChunk = "";

  for (const para of paragraphs) {
    // If adding this paragraph would exceed the limit, save current and start new
    if (
      currentChunk.length > 0 &&
      currentChunk.length + para.length + 2 > maxChars
    ) {
      chunks.push(currentChunk.trim());

      // Keep overlap from end of current chunk
      if (overlapChars > 0 && currentChunk.length > overlapChars) {
        const overlapText = currentChunk.slice(-overlapChars);
        currentChunk = overlapText + "\n\n" + para;
      } else {
        currentChunk = para;
      }
    } else {
      currentChunk = currentChunk
        ? currentChunk + "\n\n" + para
        : para;
    }

    // If a single paragraph is very long, split it by sentences
    if (currentChunk.length > maxChars * 1.5) {
      const sentences = currentChunk.split(/(?<=[.!?])\s+/);
      let subChunk = "";
      for (const sentence of sentences) {
        if (
          subChunk.length > 0 &&
          subChunk.length + sentence.length + 1 > maxChars
        ) {
          chunks.push(subChunk.trim());
          subChunk =
            overlapChars > 0 && subChunk.length > overlapChars
              ? subChunk.slice(-overlapChars) + " " + sentence
              : sentence;
        } else {
          subChunk = subChunk ? subChunk + " " + sentence : sentence;
        }
      }
      currentChunk = subChunk;
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  // Filter out tiny chunks (less than 50 chars)
  return chunks.filter((c) => c.length >= 50);
}

/**
 * Convert a number[] to a Buffer for SQLite BLOB storage.
 */
export function embeddingToBuffer(embedding: number[]): Buffer {
  const buf = Buffer.alloc(embedding.length * 4);
  for (let i = 0; i < embedding.length; i++) {
    buf.writeFloatLE(embedding[i], i * 4);
  }
  return buf;
}

/**
 * Convert a SQLite BLOB back to a number[] embedding.
 */
export function bufferToEmbedding(buf: Buffer): number[] {
  const result: number[] = [];
  for (let i = 0; i < buf.length; i += 4) {
    result.push(buf.readFloatLE(i));
  }
  return result;
}

export { EMBEDDING_DIM };
