/**
 * Map detection and tactical JSON parsing for CS2 map integration.
 * Detects map names in user messages and provides map context for the LLM.
 */

import * as fs from "fs";
import * as path from "path";

export const MAP_NAMES = [
  "dust2",
  "mirage",
  "inferno",
  "ancient",
  "anubis",
  "nuke",
  "overpass",
  "vertigo",
] as const;

export type MapName = (typeof MAP_NAMES)[number];

export interface TacticalData {
  map: string;
  side: "CT" | "T";
  strategy: string;
  players: Array<{
    position: string;
    role: string;
    team: "CT" | "T";
  }>;
  utility: Array<{
    type: string;
    from: string;
    to: string;
    description: string;
  }>;
  arrows: Array<{
    from: string;
    to: string;
    type: "movement" | "utility" | "rotation";
  }>;
}

interface MapCallout {
  name: string;
  x: number;
  y: number;
  zone: string;
  description: string;
}

interface MapData {
  name: string;
  displayName: string;
  viewBox: number[];
  sites: Record<string, { x: number; y: number }>;
  spawns: Record<string, { x: number; y: number }>;
  callouts: MapCallout[];
}

const MAPS_DIR = path.join(process.cwd(), "data", "maps");

// Cache for loaded map data to avoid repeated file reads
const mapDataCache = new Map<string, { data: MapData; timestamp: number }>();
const CACHE_TTL = 60_000; // 1 minute

/**
 * Detect if the user message mentions a CS2 map name.
 * Returns the canonical map name (lowercase) or null.
 */
export function detectMapMention(message: string): string | null {
  const lower = message.toLowerCase();

  // Special aliases for maps with spaces/alternate names
  const aliases: Record<string, string[]> = {
    dust2: ["dust2", "dust 2", "de_dust2", "de dust2", "dust_2"],
    mirage: ["mirage", "de_mirage"],
    inferno: ["inferno", "de_inferno"],
    ancient: ["ancient", "de_ancient"],
    anubis: ["anubis", "de_anubis"],
    nuke: ["nuke", "de_nuke"],
    overpass: ["overpass", "de_overpass"],
    vertigo: ["vertigo", "de_vertigo"],
  };

  for (const mapName of MAP_NAMES) {
    const patterns = aliases[mapName] || [mapName];
    for (const alias of patterns) {
      // Use word boundary for single-word names, flexible for multi-word
      const escaped = alias.replace(/\s+/g, "\\s+");
      const regex = new RegExp(`\\b${escaped}\\b`, "i");
      if (regex.test(lower)) {
        return mapName;
      }
    }
  }

  return null;
}

/**
 * Load map data from JSON file (with caching).
 */
function loadMapData(mapName: string): MapData | null {
  const cached = mapDataCache.get(mapName);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  try {
    const filePath = path.join(MAPS_DIR, `${mapName}.json`);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const data: MapData = JSON.parse(raw);
    mapDataCache.set(mapName, { data, timestamp: Date.now() });
    return data;
  } catch (error) {
    console.error(`[map-detection] Failed to load map data for ${mapName}:`, error);
    return null;
  }
}

/**
 * Build formatted map context string for injection into the LLM system prompt.
 * Lists all callout names, site positions, and spawn positions.
 */
export function getMapContext(mapName: string): string {
  const data = loadMapData(mapName);
  if (!data) {
    return `[Map data for ${mapName} not available]`;
  }

  const calloutNames = data.callouts.map((c) => c.name);

  // Skip tactical prompt for maps with no callout data (e.g. vertigo)
  if (calloutNames.length === 0) {
    return `[Map: ${data.displayName} (${data.name}) — Callout data not yet available for this map. Answer from general CS2 knowledge.]`;
  }

  const siteInfo = Object.entries(data.sites)
    .map(([name, pos]) => `  ${name} Site: (${pos.x}, ${pos.y})`)
    .join("\n");
  const spawnInfo = Object.entries(data.spawns)
    .map(([name, pos]) => `  ${name} Spawn: (${pos.x}, ${pos.y})`)
    .join("\n");

  return `MAP: ${data.displayName} (${data.name})
VIEWBOX: ${data.viewBox.join(" x ")}

AVAILABLE CALLOUTS (${calloutNames.length} total):
${calloutNames.join(", ")}

SITE POSITIONS:
${siteInfo}

SPAWN POSITIONS:
${spawnInfo}

IMPORTANT: When referencing positions in tactical diagrams, use ONLY the callout names listed above.`;
}

/**
 * Extract a tactical JSON block from the LLM response.
 * Looks for a JSON code block tagged as "tactical" or containing the expected schema fields.
 */
export function parseTacticalJSON(llmResponse: string): TacticalData | null {
  // Strategy 1: Look for ```tactical or ```json block with tactical schema
  const codeBlockPatterns = [
    /```tactical\s*\n([\s\S]*?)```/i,
    /```json\s*\n([\s\S]*?)```/i,
    /```\s*\n([\s\S]*?)```/,
  ];

  for (const pattern of codeBlockPatterns) {
    const match = llmResponse.match(pattern);
    if (match) {
      const candidate = match[1].trim();
      const parsed = tryParseTactical(candidate);
      if (parsed) return parsed;
    }
  }

  // Strategy 2: Look for a JSON object inline that contains "strategy" and "players" keys
  const inlineMatch = llmResponse.match(
    /\{\s*"map"\s*:\s*"[^"]*"[^{]*"players"\s*:\s*\[[\s\S]*?\}\s*\]/
  );
  if (inlineMatch) {
    // Try to find the full JSON object by balanced braces
    const fullJson = extractBalancedJSON(llmResponse, inlineMatch.index!);
    if (fullJson) {
      const parsed = tryParseTactical(fullJson);
      if (parsed) return parsed;
    }
  }

  return null;
}

/**
 * Try to parse a string as TacticalData, validating required fields.
 */
function tryParseTactical(jsonStr: string): TacticalData | null {
  try {
    const obj = JSON.parse(jsonStr);
    if (!obj.map || !obj.side || !obj.strategy) return null;
    if (!Array.isArray(obj.players)) return null;

    // Normalize side
    const side = obj.side.toUpperCase();
    if (side !== "CT" && side !== "T") return null;

    return {
      map: obj.map.toLowerCase(),
      side: side as "CT" | "T",
      strategy: String(obj.strategy),
      players: Array.isArray(obj.players) ? obj.players : [],
      utility: Array.isArray(obj.utility) ? obj.utility : [],
      arrows: Array.isArray(obj.arrows) ? obj.arrows : [],
    };
  } catch {
    return null;
  }
}

/**
 * Extract a balanced JSON object starting from a given index.
 */
function extractBalancedJSON(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end === -1) return null;
  return text.slice(startIndex, end + 1);
}

/**
 * Validate that all callout names used in tactical data exist for the given map.
 * Returns an object with valid flag and list of unknown callouts.
 */
export function validateTacticalCallouts(
  tactical: TacticalData
): { valid: boolean; unknown: string[] } {
  const data = loadMapData(tactical.map);
  if (!data) {
    return { valid: false, unknown: [`Map "${tactical.map}" not found`] };
  }

  const knownCallouts = new Set(data.callouts.map((c) => c.name.toLowerCase()));

  // Add common positional references that should always be valid
  knownCallouts.add("a site");
  knownCallouts.add("b site");
  knownCallouts.add("ct spawn");
  knownCallouts.add("t spawn");
  knownCallouts.add("mid");

  const unknown: string[] = [];
  const checkPosition = (pos: string) => {
    if (!knownCallouts.has(pos.toLowerCase())) {
      unknown.push(pos);
    }
  };

  for (const player of tactical.players) {
    checkPosition(player.position);
  }
  for (const util of tactical.utility) {
    checkPosition(util.from);
    checkPosition(util.to);
  }
  for (const arrow of tactical.arrows) {
    checkPosition(arrow.from);
    checkPosition(arrow.to);
  }

  return { valid: unknown.length === 0, unknown };
}

/**
 * Convert TacticalData (from LLM JSON) to TacticalMapOptions (for map-renderer).
 * Maps field names and enum values to match the renderer's expected interface.
 */
export function toRendererOptions(tactical: TacticalData) {
  // Map arrow types from LLM schema to renderer schema
  const mapArrowType = (t: string): "push" | "throw" => {
    switch (t.toLowerCase()) {
      case "movement":
      case "rotation":
        return "push";
      case "utility":
        return "throw";
      default:
        return "push";
    }
  };

  // Map player role to renderer's expected enum
  const mapRole = (r: string): "entry" | "support" | "awp" | "igl" | "lurk" => {
    const lower = r.toLowerCase();
    if (lower.includes("entry") || lower.includes("fragger")) return "entry";
    if (lower.includes("support") || lower.includes("anchor")) return "support";
    if (lower.includes("awp") || lower.includes("sniper")) return "awp";
    if (lower.includes("igl") || lower.includes("caller") || lower.includes("lead")) return "igl";
    if (lower.includes("lurk") || lower.includes("flank") || lower.includes("rotate")) return "lurk";
    // Default to support for unknown roles
    return "support";
  };

  return {
    mapName: tactical.map,
    side: tactical.side,
    title: tactical.strategy,
    players: tactical.players.map((p) => ({
      position: p.position,
      role: mapRole(p.role),
      team: p.team,
    })),
    utility: tactical.utility.map((u) => ({
      type: u.type as "smoke" | "flash" | "molotov" | "he",
      from: u.from,
      to: u.to,
      label: u.description,
    })),
    arrows: tactical.arrows.map((a) => ({
      from: a.from,
      to: a.to,
      type: mapArrowType(a.type),
    })),
    showZones: true,
    showCallouts: true,
  };
}

/**
 * Instructions appended to the system prompt when a map is detected.
 * Tells the LLM how to format tactical output.
 */
export const TACTICAL_PROMPT_INSTRUCTION = `
TACTICAL MAP OUTPUT INSTRUCTIONS:
When you discuss CS2 map strategies, positions, or tactics for a specific map, you MUST include a JSON code block with tactical data so a visual map diagram can be generated. Use this exact format:

\`\`\`tactical
{
  "map": "<map_name>",
  "side": "CT" or "T",
  "strategy": "<brief strategy name>",
  "players": [
    {"position": "<callout_name>", "role": "<role_description>", "team": "CT" or "T"}
  ],
  "utility": [
    {"type": "smoke|flash|molotov|he", "from": "<callout_name>", "to": "<callout_name>", "description": "<what it does>"}
  ],
  "arrows": [
    {"from": "<callout_name>", "to": "<callout_name>", "type": "movement|utility|rotation"}
  ]
}
\`\`\`

RULES for tactical JSON:
- Use ONLY callout names from the provided callout list for the map
- "position" must be an exact callout name from the list
- "from" and "to" must be exact callout names from the list
- Include 5 players per team for a full execute/retake setup
- Add arrows to show movement paths and rotations
- Add utility entries for each grenade/smoke/flash used in the strategy
- The "type" for utility must be one of: smoke, flash, molotov, he
- The "type" for arrows must be one of: movement, utility, rotation
- Always include this JSON block AFTER your textual explanation
- Even for simple questions about positions or strategies, include a minimal tactical JSON
`.trim();
