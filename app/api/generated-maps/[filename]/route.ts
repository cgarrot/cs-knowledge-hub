import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";

const GENERATED_DIR = path.join(process.cwd(), "public", "generated-maps");

/**
 * GET /api/generated-maps/[filename]
 * Serves dynamically generated SVG map files from public/generated-maps/.
 * Next.js production build doesn't serve files added to public/ after build,
 * so we need this API route to serve them.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;

  // Sanitize: only allow alphanumeric, dash, dot
  const safe = filename.replace(/[^a-z0-9.\-_]/gi, "");
  if (safe !== filename) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  // Only serve SVG files
  if (!safe.endsWith(".svg")) {
    return NextResponse.json({ error: "Only SVG files" }, { status: 400 });
  }

  const filePath = path.join(GENERATED_DIR, safe);

  // Prevent path traversal
  if (!filePath.startsWith(GENERATED_DIR)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const svg = fs.readFileSync(filePath, "utf-8");
    return new NextResponse(svg, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
