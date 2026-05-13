/**
 * POST /api/map-tactics
 * Accepts tactical data, validates it, generates an SVG map diagram, and returns the URL.
 */

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import {
  type TacticalData,
  validateTacticalCallouts,
  toRendererOptions,
  MAP_NAMES,
} from "@/lib/map-detection";

export const runtime = "nodejs";

// Ensure the output directory exists
const OUTPUT_DIR = path.join(process.cwd(), "public", "generated-maps");

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

/**
 * Try to import the map renderer (Phase 2 dependency).
 * Falls back gracefully if not available yet.
 */
async function getMapRenderer() {
  try {
    const mod = await import("@/lib/map-renderer");
    return mod.renderTacticalMap || null;
  } catch {
    console.warn("[map-tactics] map-renderer module not available yet");
    return null;
  }
}

/**
 * Generate a simple fallback SVG when the renderer is not available.
 */
function generateFallbackSVG(tactical: TacticalData): string {
  // Load map data for callout positions
  const mapPath = path.join(process.cwd(), "data", "maps", `${tactical.map}.json`);
  let callouts: Array<{ name: string; x: number; y: number }> = [];
  let sites: Record<string, { x: number; y: number }> = {};
  let spawns: Record<string, { x: number; y: number }> = {};
  let displayName = tactical.map;

  try {
    const raw = fs.readFileSync(mapPath, "utf-8");
    const data = JSON.parse(raw);
    callouts = data.callouts || [];
    sites = data.sites || {};
    spawns = data.spawns || {};
    displayName = data.displayName || tactical.map;
  } catch {
    // No map data available, use defaults
  }

  const calloutMap = new Map(callouts.map((c) => [c.name.toLowerCase(), c]));

  // SVG dimensions
  const width = 800;
  const height = 600;
  const scaleX = width / 1000;
  const scaleY = height / 1000;

  const elements: string[] = [];

  // Background
  elements.push(`<rect width="${width}" height="${height}" fill="#1a1a2e"/>`);

  // Title
  elements.push(
    `<text x="${width / 2}" y="30" fill="#e0e0e0" font-size="18" font-weight="bold" text-anchor="middle">${displayName} - ${tactical.side} ${tactical.strategy}</text>`
  );

  // Grid lines
  for (let i = 0; i <= 10; i++) {
    const x = (i * width) / 10;
    const y = (i * height) / 10;
    elements.push(`<line x1="${x}" y1="40" x2="${x}" y2="${height}" stroke="#2a2a4e" stroke-width="0.5"/>`);
    elements.push(`<line x1="0" y1="${40 + y * 0.95}" x2="${width}" y2="${40 + y * 0.95}" stroke="#2a2a4e" stroke-width="0.5"/>`);
  }

  // Site markers
  for (const [name, pos] of Object.entries(sites)) {
    const sx = pos.x * scaleX;
    const sy = pos.y * scaleY + 20;
    elements.push(`<circle cx="${sx}" cy="${sy}" r="20" fill="none" stroke="#ff6b6b" stroke-width="2" opacity="0.6"/>`);
    elements.push(`<text x="${sx}" y="${sy + 5}" fill="#ff6b6b" font-size="14" font-weight="bold" text-anchor="middle">${name}</text>`);
  }

  // Spawn markers
  for (const [name, pos] of Object.entries(spawns)) {
    const sx = pos.x * scaleX;
    const sy = pos.y * scaleY + 20;
    const color = name === "CT" ? "#4ecdc4" : "#ff8c42";
    elements.push(`<rect x="${sx - 15}" y="${sy - 10}" width="30" height="20" rx="3" fill="${color}" opacity="0.4"/>`);
    elements.push(`<text x="${sx}" y="${sy + 5}" fill="${color}" font-size="10" text-anchor="middle">${name}</text>`);
  }

  // Arrow definitions
  elements.push(`<defs><marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#ffd93d"/></marker></defs>`);

  // Draw arrows
  for (const arrow of tactical.arrows) {
    const from = calloutMap.get(arrow.from.toLowerCase());
    const to = calloutMap.get(arrow.to.toLowerCase());
    if (from && to) {
      const fx = from.x * scaleX;
      const fy = from.y * scaleY + 20;
      const tx = to.x * scaleX;
      const ty = to.y * scaleY + 20;
      const color = arrow.type === "movement" ? "#4ecdc4" : arrow.type === "utility" ? "#ff6b6b" : "#ffd93d";
      const markerId = arrow.type === "movement" ? "arrowhead" : arrow.type === "utility" ? "arrowhead" : "arrowhead";
      elements.push(
        `<line x1="${fx}" y1="${fy}" x2="${tx}" y2="${ty}" stroke="${color}" stroke-width="2" marker-end="url(#${markerId})" opacity="0.7"/>`
      );
    }
  }

  // Draw players
  for (const player of tactical.players) {
    const pos = calloutMap.get(player.position.toLowerCase());
    if (pos) {
      const px = pos.x * scaleX;
      const py = pos.y * scaleY + 20;
      const color = player.team === "CT" ? "#4ecdc4" : "#ff8c42";
      elements.push(`<circle cx="${px}" cy="${py}" r="8" fill="${color}" stroke="#fff" stroke-width="1.5"/>`);
      elements.push(`<text x="${px}" y="${py - 12}" fill="${color}" font-size="9" text-anchor="middle">${player.role}</text>`);
    }
  }

  // Utility labels
  for (const util of tactical.utility) {
    const to = calloutMap.get(util.to.toLowerCase());
    if (to) {
      const ux = to.x * scaleX;
      const uy = to.y * scaleY + 20;
      const emoji = util.type === "smoke" ? "💨" : util.type === "flash" ? "⚡" : util.type === "molotov" ? "🔥" : "💥";
      elements.push(`<text x="${ux + 12}" y="${uy - 5}" fill="#ffd93d" font-size="12">${emoji}</text>`);
    }
  }

  // Legend
  const legendY = height - 30;
  elements.push(`<circle cx="20" cy="${legendY}" r="5" fill="#4ecdc4"/>`);
  elements.push(`<text x="30" y="${legendY + 4}" fill="#aaa" font-size="10">CT</text>`);
  elements.push(`<circle cx="70" cy="${legendY}" r="5" fill="#ff8c42"/>`);
  elements.push(`<text x="80" y="${legendY + 4}" fill="#aaa" font-size="10">T</text>`);
  elements.push(`<line x1="120" y1="${legendY}" x2="150" y2="${legendY}" stroke="#4ecdc4" stroke-width="2"/>`);
  elements.push(`<text x="155" y="${legendY + 4}" fill="#aaa" font-size="10">Movement</text>`);
  elements.push(`<line x1="230" y1="${legendY}" x2="260" y2="${legendY}" stroke="#ff6b6b" stroke-width="2"/>`);
  elements.push(`<text x="265" y="${legendY + 4}" fill="#aaa" font-size="10">Utility</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">\n${elements.join("\n")}\n</svg>`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { tactical } = body as { tactical: TacticalData };

    if (!tactical) {
      return NextResponse.json(
        { success: false, error: "Missing tactical data" },
        { status: 400 }
      );
    }

    // Validate required fields
    if (!tactical.map || !tactical.side || !tactical.strategy) {
      return NextResponse.json(
        { success: false, error: "Missing required fields: map, side, strategy" },
        { status: 400 }
      );
    }

    // Validate map name
    if (!MAP_NAMES.includes(tactical.map.toLowerCase() as any)) {
      return NextResponse.json(
        {
          success: false,
          error: `Unknown map: ${tactical.map}. Valid maps: ${MAP_NAMES.join(", ")}`,
        },
        { status: 400 }
      );
    }

    // Validate side
    const side = tactical.side.toUpperCase();
    if (side !== "CT" && side !== "T") {
      return NextResponse.json(
        { success: false, error: `Invalid side: ${tactical.side}. Must be CT or T.` },
        { status: 400 }
      );
    }

    // Validate callout names
    const validation = validateTacticalCallouts(tactical);
    if (!validation.valid) {
      console.warn(
        `[map-tactics] Unknown callouts in tactical data: ${validation.unknown.join(", ")}`
      );
      // Log warning but don't fail — we do our best to render
    }

    // Generate SVG
    const normalizedTactical: TacticalData = {
      ...tactical,
      map: tactical.map.toLowerCase(),
      side: side as "CT" | "T",
    };

    let svg: string;

    // Try the full map renderer first
    const renderFn = await getMapRenderer();
    if (renderFn) {
      try {
        const rendererOpts = toRendererOptions(normalizedTactical);
        svg = await renderFn(rendererOpts);
      } catch (renderError) {
        console.warn("[map-tactics] Renderer failed, using fallback:", renderError);
        svg = generateFallbackSVG(normalizedTactical);
      }
    } else {
      // Fallback SVG generation
      svg = generateFallbackSVG(normalizedTactical);
    }

    // Save SVG to disk
    ensureOutputDir();
    const timestamp = Date.now();
    const filename = `${normalizedTactical.map}-${timestamp}.svg`;
    const filePath = path.join(OUTPUT_DIR, filename);
    fs.writeFileSync(filePath, svg, "utf-8");

    const svgUrl = `/api/generated-maps/${filename}`;

    return NextResponse.json({
      success: true,
      svgUrl,
      mapData: normalizedTactical,
    });
  } catch (error) {
    console.error("[map-tactics] Error:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error generating tactical map" },
      { status: 500 }
    );
  }
}
