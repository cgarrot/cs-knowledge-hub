/**
 * Embedding generation utilities.
 * 
 * Uses a lightweight embedding model or external API.
 * For now, this is a placeholder — actual embedding model
 * will be configured based on available resources.
 */

const EMBEDDING_API_URL = process.env.EMBEDDING_API_URL || "";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "nomic-embed-text";

export interface EmbeddingResponse {
  embedding: number[];
  model: string;
}

/**
 * Generate an embedding for the given text.
 * Placeholder implementation — will be connected to Ollama or similar.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  if (!EMBEDDING_API_URL) {
    // Return a dummy embedding for development
    console.warn("[embeddings] No EMBEDDING_API_URL configured, returning dummy embedding");
    return new Array(384).fill(0);
  }

  try {
    const response = await fetch(`${EMBEDDING_API_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        prompt: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status}`);
    }

    const data = await response.json();
    return data.embedding;
  } catch (error) {
    console.error("[embeddings] Error generating embedding:", error);
    return new Array(384).fill(0);
  }
}

/**
 * Chunk text into pieces of roughly `chunkSize` tokens.
 * Simple character-based chunking with overlap.
 */
export function chunkText(text: string, chunkSize = 500, overlap = 50): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = start + chunkSize;
    chunks.push(text.slice(start, end));
    start += chunkSize - overlap;
  }

  return chunks;
}
