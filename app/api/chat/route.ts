import { NextRequest, NextResponse } from "next/server";
import { generateEmbedding } from "@/lib/embeddings";
import { findSimilar } from "@/lib/db";
import { buildRAGPrompt, streamChat, type ChatMessage } from "@/lib/llm";

export const runtime = "nodejs";
export const maxDuration = 60;

interface ChatRequestBody {
  messages: ChatMessage[];
}

export async function POST(request: NextRequest) {
  try {
    const body: ChatRequestBody = await request.json();
    const { messages } = body;

    if (!messages || messages.length === 0) {
      return NextResponse.json({ error: "No messages provided" }, { status: 400 });
    }

    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role !== "user") {
      return NextResponse.json({ error: "Last message must be from user" }, { status: 400 });
    }

    // RAG: retrieve relevant context
    let context = "";
    try {
      const queryEmbedding = await generateEmbedding(lastMessage.content);
      const similar = findSimilar(queryEmbedding, 8);

      if (similar.length > 0) {
        const contextParts = similar.map((s) => {
          const source = s.file_path
            .replace(/\.md$/, "")
            .replace(/[-_]/g, " ");
          const meta = [
            s.category ? `Category: ${s.category}` : "",
            s.subcategory ? `Sub: ${s.subcategory}` : "",
            s.skill_level ? `Level: ${s.skill_level}` : "",
          ]
            .filter(Boolean)
            .join(" | ");
          return `[Source: ${source}${meta ? ` (${meta})` : ""} - Relevance: ${(s.score * 100).toFixed(0)}%]\n${s.chunk_text}`;
        });
        context = contextParts.join("\n\n---\n\n");
      }
    } catch (error) {
      console.warn("[chat] RAG retrieval failed, continuing without context:", error);
    }

    // Build messages for LLM
    const systemMessage: ChatMessage = {
      role: "system",
      content: buildRAGPrompt(context || "No relevant documents found in the knowledge base."),
    };

    const llmMessages: ChatMessage[] = [systemMessage, ...messages];

    // Stream response
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of streamChat(llmMessages)) {
            const data = JSON.stringify({ content: chunk });
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (error) {
          console.error("[chat] Stream error:", error);
          const errorData = JSON.stringify({
            content: "An error occurred during streaming.",
          });
          controller.enqueue(encoder.encode(`data: ${errorData}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    console.error("[chat] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
