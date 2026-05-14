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
  repairTacticalCallouts,
  toRendererOptions,
  MAP_NAMES,
} from "@/lib/map-detection";
import { writeGeneratedMapSvg } from "@/lib/generated-maps";
import { readLimitedRequestText } from "@/lib/request-body";

export const runtime = "nodejs";

const MAX_REQUEST_CHARS = 50_000;
const MAX_FIELD_CHARS = 500;
const MAX_PLAYERS = 20;
const MAX_UTILITY = 30;
const MAX_ARROWS = 50;
const MAX_PHASES = 8;
const MAX_PHASE_CALLOUTS = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
  field: string,
  required: boolean,
  errors: string[],
  maxLength = MAX_FIELD_CHARS
): string | undefined {
  const value = record[key];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      if (required) errors.push(`${field} is required`);
      return undefined;
    }
    if (trimmed.length > maxLength) {
      errors.push(`${field} is too long`);
      return undefined;
    }
    return trimmed;
  }
  if (value === undefined || value === null) {
    if (required) errors.push(`${field} is required`);
    return undefined;
  }
  errors.push(`${field} must be a string`);
  return undefined;
}

function readArray(
  record: Record<string, unknown>,
  key: string,
  field: string,
  maxLength: number,
  errors: string[]
): unknown[] {
  const value = record[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return [];
  }
  if (value.length > maxLength) {
    errors.push(`${field} exceeds max ${maxLength}`);
    return [];
  }
  return value;
}

function normalizeTacticalPayload(rawBody: string): { tactical?: TacticalData; error?: string; status?: number } {
  if (rawBody.length > MAX_REQUEST_CHARS) {
    return { error: "Tactical request body is too large", status: 413 };
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { error: "Invalid JSON request body", status: 400 };
  }

  if (!isRecord(body) || !isRecord(body.tactical)) {
    return { error: "Missing tactical data", status: 400 };
  }

  const raw = body.tactical;
  const errors: string[] = [];
  const map = readString(raw, "map", "tactical.map", true, errors, 80)?.toLowerCase();
  const sideRaw = readString(raw, "side", "tactical.side", true, errors, 8)?.toUpperCase();
  const strategy = readString(raw, "strategy", "tactical.strategy", true, errors, 200);
  const side = sideRaw === "CT" || sideRaw === "T" ? sideRaw : undefined;
  if (sideRaw && !side) errors.push("tactical.side must be CT or T");

  const playersRaw = readArray(raw, "players", "tactical.players", MAX_PLAYERS, errors);
  const utilityRaw = readArray(raw, "utility", "tactical.utility", MAX_UTILITY, errors);
  const arrowsRaw = readArray(raw, "arrows", "tactical.arrows", MAX_ARROWS, errors);
  const phasesRaw = readArray(raw, "phases", "tactical.phases", MAX_PHASES, errors);

  const players: TacticalData["players"] = [];
  playersRaw.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`tactical.players[${index}] must be an object`);
      return;
    }
    const position = readString(item, "position", `tactical.players[${index}].position`, true, errors);
    const role = readString(item, "role", `tactical.players[${index}].role`, false, errors) || "support";
    const teamRaw = readString(item, "team", `tactical.players[${index}].team`, false, errors, 8)?.toUpperCase();
    const team = teamRaw === "CT" || teamRaw === "T" ? teamRaw : side;
    if (teamRaw && teamRaw !== "CT" && teamRaw !== "T") errors.push(`tactical.players[${index}].team must be CT or T`);
    if (position && team) {
      players.push({
        position,
        role,
        team,
        label: readString(item, "label", `tactical.players[${index}].label`, false, errors),
        timing: readString(item, "timing", `tactical.players[${index}].timing`, false, errors),
        task: readString(item, "task", `tactical.players[${index}].task`, false, errors),
        phase: readString(item, "phase", `tactical.players[${index}].phase`, false, errors, 80),
      });
    }
  });

  const utility: TacticalData["utility"] = [];
  utilityRaw.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`tactical.utility[${index}] must be an object`);
      return;
    }
    const to = readString(item, "to", `tactical.utility[${index}].to`, true, errors);
    if (to) {
      utility.push({
        type: readString(item, "type", `tactical.utility[${index}].type`, false, errors, 40) || "smoke",
        from: readString(item, "from", `tactical.utility[${index}].from`, false, errors) || "",
        to,
        description: readString(item, "description", `tactical.utility[${index}].description`, false, errors) || `Utility on ${to}`,
        timing: readString(item, "timing", `tactical.utility[${index}].timing`, false, errors),
        purpose: readString(item, "purpose", `tactical.utility[${index}].purpose`, false, errors),
        player: readString(item, "player", `tactical.utility[${index}].player`, false, errors),
        phase: readString(item, "phase", `tactical.utility[${index}].phase`, false, errors, 80),
      });
    }
  });

  const arrows: TacticalData["arrows"] = [];
  arrowsRaw.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`tactical.arrows[${index}] must be an object`);
      return;
    }
    const from = readString(item, "from", `tactical.arrows[${index}].from`, true, errors);
    const to = readString(item, "to", `tactical.arrows[${index}].to`, true, errors);
    const typeRaw = readString(item, "type", `tactical.arrows[${index}].type`, false, errors, 40);
    const type = typeRaw === "utility" || typeRaw === "rotation" || typeRaw === "movement" ? typeRaw : "movement";
    if (from && to) {
      arrows.push({
        from,
        to,
        type,
        label: readString(item, "label", `tactical.arrows[${index}].label`, false, errors),
        timing: readString(item, "timing", `tactical.arrows[${index}].timing`, false, errors),
        phase: readString(item, "phase", `tactical.arrows[${index}].phase`, false, errors),
      });
    }
  });

  const phases: NonNullable<TacticalData["phases"]> = [];
  phasesRaw.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`tactical.phases[${index}] must be an object`);
      return;
    }
    const name = readString(item, "name", `tactical.phases[${index}].name`, true, errors);
    const calloutsRaw = readArray(item, "callouts", `tactical.phases[${index}].callouts`, MAX_PHASE_CALLOUTS, errors);
    const callouts: string[] = [];
    calloutsRaw.forEach((callout, calloutIndex) => {
      if (typeof callout !== "string" || callout.trim().length === 0) {
        errors.push(`tactical.phases[${index}].callouts[${calloutIndex}] must be a string`);
      } else if (callout.length > MAX_FIELD_CHARS) {
        errors.push(`tactical.phases[${index}].callouts[${calloutIndex}] is too long`);
      } else {
        callouts.push(callout.trim());
      }
    });
    if (name) {
      phases.push({
        name,
        timing: readString(item, "timing", `tactical.phases[${index}].timing`, false, errors),
        description: readString(item, "description", `tactical.phases[${index}].description`, false, errors),
        callouts,
      });
    }
  });

  if (errors.length > 0 || !map || !side || !strategy) {
    return { error: errors[0] || "Invalid tactical data", status: 400 };
  }

  return {
    tactical: { map, side, strategy, players, utility, arrows, phases },
  };
}

function escSvgText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function phaseTypeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (/retake|reprise|defuse/.test(lower)) return "retake";
  if (/post[-\s]?plant|after\s+plant/.test(lower)) return "post-plant";
  if (/execute|exec|commit|pop|contact/.test(lower)) return "execute";
  if (/map\s*control|control|default|mid[-\s]?round/.test(lower)) return "map-control";
  if (/rotate|rotation|fallback|regroup/.test(lower)) return "rotation";
  if (/opening|spawn|start|initial|0:00/.test(lower)) return "opening";
  return "custom";
}

function getPhaseMetadata(tactical: TacticalData) {
  return (tactical.phases || []).slice(0, MAX_PHASES).map((phase, index) => ({
    index,
    name: phase.name,
    timing: phase.timing,
    type: phaseTypeFromName(phase.name),
    description: phase.description,
  }));
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
  } catch (error) {
    console.warn("[map-tactics] Fallback SVG map data unavailable, using defaults:", error);
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
    `<text x="${width / 2}" y="30" fill="#e0e0e0" font-size="18" font-weight="bold" text-anchor="middle">${escSvgText(`${displayName} - ${tactical.side} ${tactical.strategy}`)}</text>`
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
    elements.push(`<text x="${sx}" y="${sy + 5}" fill="#ff6b6b" font-size="14" font-weight="bold" text-anchor="middle">${escSvgText(name)}</text>`);
  }

  // Spawn markers
  for (const [name, pos] of Object.entries(spawns)) {
    const sx = pos.x * scaleX;
    const sy = pos.y * scaleY + 20;
    const color = name === "CT" ? "#4ecdc4" : "#ff8c42";
    elements.push(`<rect x="${sx - 15}" y="${sy - 10}" width="30" height="20" rx="3" fill="${color}" opacity="0.4"/>`);
    elements.push(`<text x="${sx}" y="${sy + 5}" fill="${color}" font-size="10" text-anchor="middle">${escSvgText(name)}</text>`);
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
      elements.push(`<text x="${px}" y="${py - 12}" fill="${color}" font-size="9" text-anchor="middle">${escSvgText(player.role)}</text>`);
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
    const rawRequest = await readLimitedRequestText(
      request,
      MAX_REQUEST_CHARS,
      "Tactical request body is too large"
    );
    if (rawRequest.error) {
      return NextResponse.json(
        { success: false, error: rawRequest.error },
        { status: rawRequest.status || 400 }
      );
    }

    const parsedRequest = normalizeTacticalPayload(rawRequest.text || "");
    if (!parsedRequest.tactical) {
      return NextResponse.json(
        { success: false, error: parsedRequest.error || "Invalid tactical data" },
        { status: parsedRequest.status || 400 }
      );
    }
    const { tactical } = parsedRequest;

    // Validate map name
    const validMapNames: readonly string[] = MAP_NAMES;
    if (!validMapNames.includes(tactical.map)) {
      return NextResponse.json(
        {
          success: false,
          error: `Unknown map: ${tactical.map}. Valid maps: ${MAP_NAMES.join(", ")}`,
        },
        { status: 400 }
      );
    }

    const repairedTactical = repairTacticalCallouts(tactical);
    if (!repairedTactical) {
      return NextResponse.json(
        { success: false, error: "No valid tactical callouts to render" },
        { status: 400 }
      );
    }

    if (!validMapNames.includes(repairedTactical.map)) {
      return NextResponse.json(
        { success: false, error: `Unknown repaired map: ${repairedTactical.map}` },
        { status: 400 }
      );
    }

    // Validate repaired callout names. Repair runs first so aliases like "A" or
    // "ct" do not generate noisy warnings and oversized inputs are already rejected.
    const validation = validateTacticalCallouts(repairedTactical);
    if (!validation.valid) {
      const preview = validation.unknown.slice(0, 10).join(", ");
      console.warn(
        `[map-tactics] Unknown callouts in repaired tactical data (${validation.unknown.length}): ${preview}`
      );
      // Log warning but don't fail — we do our best to render
    }

    let svg: string;

    // Try the full map renderer first
    const renderFn = await getMapRenderer();
    if (renderFn) {
      try {
        const rendererOpts = toRendererOptions(repairedTactical);
        svg = await renderFn(rendererOpts);
      } catch (renderError) {
        console.warn("[map-tactics] Renderer failed, using fallback:", renderError);
        svg = generateFallbackSVG(repairedTactical);
      }
    } else {
      // Fallback SVG generation
      svg = generateFallbackSVG(repairedTactical);
    }

    const generatedMap = writeGeneratedMapSvg(repairedTactical.map, svg);
    if (!generatedMap) {
      return NextResponse.json(
        { success: false, error: "Invalid map name for generated file" },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      svgUrl: generatedMap.url,
      phases: getPhaseMetadata(repairedTactical),
      mapData: repairedTactical,
    });
  } catch (error) {
    console.error("[map-tactics] Error:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error generating tactical map" },
      { status: 500 }
    );
  }
}
