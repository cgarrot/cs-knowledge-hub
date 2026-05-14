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
    label?: string;
    timing?: string;
    task?: string;
  }>;
  utility: Array<{
    type: string;
    from: string;
    to: string;
    description: string;
    timing?: string;
    purpose?: string;
    player?: string;
  }>;
  arrows: Array<{
    from: string;
    to: string;
    type: "movement" | "utility" | "rotation";
    label?: string;
    timing?: string;
    phase?: string;
  }>;
  phases?: Array<{
    name: string;
    timing?: string;
    description?: string;
    callouts?: string[];
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
      phases: Array.isArray(obj.phases) ? obj.phases : [],
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
  const checkPosition = (pos: unknown) => {
    const cleaned = cleanString(pos);
    if (!cleaned || !knownCallouts.has(cleaned.toLowerCase())) {
      unknown.push(cleaned || "<missing>");
    }
  };

  const playersToValidate = Array.isArray(tactical.players) ? tactical.players : [];
  const utilityToValidate = Array.isArray(tactical.utility) ? tactical.utility : [];
  const arrowsToValidate = Array.isArray(tactical.arrows) ? tactical.arrows : [];
  const phasesToValidate = Array.isArray(tactical.phases) ? tactical.phases : [];

  for (const player of playersToValidate) {
    checkPosition(player.position);
  }
  for (const util of utilityToValidate) {
    checkPosition(util.from);
    checkPosition(util.to);
  }
  for (const arrow of arrowsToValidate) {
    checkPosition(arrow.from);
    checkPosition(arrow.to);
  }
  for (const phase of phasesToValidate) {
    const callouts = Array.isArray(phase.callouts) ? phase.callouts : [];
    for (const callout of callouts) {
      checkPosition(callout);
    }
  }

  return { valid: unknown.length === 0, unknown };
}

function buildCalloutLookup(data: MapData): Map<string, string> {
  const lookup = new Map<string, string>();

  for (const c of data.callouts) {
    lookup.set(c.name.toLowerCase(), c.name);
  }

  for (const [name] of Object.entries(data.sites)) {
    const siteCallout = data.callouts.find(
      (callout) => callout.name.toLowerCase() === `${name} site`.toLowerCase()
    )?.name || name;
    lookup.set(name.toLowerCase(), name);
    lookup.set(`${name} site`.toLowerCase(), siteCallout);
  }

  lookup.set("ct", "CT Spawn");
  lookup.set("ct spawn", "CT Spawn");
  lookup.set("t", "T Spawn");
  lookup.set("t spawn", "T Spawn");

  return lookup;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function optionalString(value: unknown): string | undefined {
  return cleanString(value) || undefined;
}

function normalizeTeam(value: unknown, fallback: "CT" | "T"): "CT" | "T" {
  const upper = cleanString(value)?.toUpperCase();
  return upper === "CT" || upper === "T" ? upper : fallback;
}

function normalizeUtilityType(value: unknown): "smoke" | "flash" | "molotov" | "he" {
  const lower = cleanString(value)?.toLowerCase() || "";
  if (lower.includes("smoke")) return "smoke";
  if (lower.includes("flash")) return "flash";
  if (lower.includes("molo") || lower.includes("molly") || lower.includes("incendiary")) return "molotov";
  if (lower === "he" || lower.includes("grenade") || lower.includes("nade")) return "he";
  return "smoke";
}

function repairCalloutName(pos: unknown, lookup: Map<string, string>): string | null {
  const cleaned = cleanString(pos);
  if (!cleaned) return null;
  return matchCallout(cleaned, lookup) || findCalloutInText(cleaned, lookup);
}

function defaultSpawn(side: "CT" | "T", lookup: Map<string, string>): string {
  return repairCalloutName(side === "CT" ? "CT Spawn" : "T Spawn", lookup) ||
    lookup.values().next().value ||
    (side === "CT" ? "CT Spawn" : "T Spawn");
}

function hasTacticalDetails(tactical: TacticalData): boolean {
  return tactical.players.length > 0 || tactical.utility.length > 0 || tactical.arrows.length > 0;
}

export function repairTacticalCallouts(tactical: TacticalData): TacticalData | null {
  const data = loadMapData(tactical.map);
  if (!data || data.callouts.length === 0) return null;

  const lookup = buildCalloutLookup(data);
  const side = normalizeTeam(tactical.side, "T");
  const fallbackSpawn = defaultSpawn(side, lookup);

  const rawPlayers = Array.isArray(tactical.players) ? tactical.players : [];
  const rawUtility = Array.isArray(tactical.utility) ? tactical.utility : [];
  const rawArrows = Array.isArray(tactical.arrows) ? tactical.arrows : [];
  const rawPhases = Array.isArray(tactical.phases) ? tactical.phases : [];

  const players: TacticalData["players"] = [];
  for (const player of rawPlayers.slice(0, 20)) {
    const position = repairCalloutName(player?.position, lookup);
    if (!position) continue;
    players.push({
      position,
      role: optionalString(player?.role) || "support",
      team: normalizeTeam(player?.team, side),
      label: optionalString(player?.label),
      timing: optionalString(player?.timing),
      task: optionalString(player?.task),
    });
  }

  const utility: TacticalData["utility"] = [];
  for (const util of rawUtility.slice(0, 30)) {
    const to = repairCalloutName(util?.to, lookup);
    if (!to) continue;
    const type = normalizeUtilityType(util?.type);
    const from = repairCalloutName(util?.from, lookup) || fallbackSpawn;
    utility.push({
      type,
      from,
      to,
      description: optionalString(util?.description) || `${type} on ${to}`,
      timing: optionalString(util?.timing),
      purpose: optionalString(util?.purpose),
      player: optionalString(util?.player),
    });
  }

  const arrows: TacticalData["arrows"] = [];
  for (const arrow of rawArrows.slice(0, 50)) {
    const from = repairCalloutName(arrow?.from, lookup);
    const to = repairCalloutName(arrow?.to, lookup);
    if (!from || !to || from.toLowerCase() === to.toLowerCase()) continue;
    const rawType = cleanString(arrow?.type)?.toLowerCase();
    arrows.push({
      from,
      to,
      type: rawType === "utility" || rawType === "rotation" ? rawType : "movement",
      label: optionalString(arrow?.label),
      timing: optionalString(arrow?.timing),
      phase: optionalString(arrow?.phase),
    });
  }

  const phases = rawPhases.slice(0, 8).flatMap((phase) => {
    const name = cleanString(phase?.name);
    if (!name) return [];
    const callouts = Array.isArray(phase?.callouts) ? phase.callouts : [];
    return [{
      name,
      timing: optionalString(phase?.timing),
      description: optionalString(phase?.description),
      callouts: callouts
        .map((callout) => repairCalloutName(callout, lookup))
        .filter((callout): callout is string => Boolean(callout)),
    }];
  });

  const repaired: TacticalData = {
    ...tactical,
    map: data.name.toLowerCase(),
    side,
    strategy: optionalString(tactical.strategy) || `${side} Strategy`,
    players,
    utility: dedupUtility(utility),
    arrows: dedupArrows(arrows),
    phases,
  };

  return hasTacticalDetails(repaired) ? repaired : null;
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
      label: p.label,
      timing: p.timing,
      task: p.task,
    })),
    utility: tactical.utility.map((u) => ({
      type: u.type as "smoke" | "flash" | "molotov" | "he",
      from: u.from,
      to: u.to,
      label: u.description,
      timing: u.timing,
      purpose: u.purpose,
      player: u.player,
    })),
    arrows: tactical.arrows.map((a) => ({
      from: a.from,
      to: a.to,
      type: mapArrowType(a.type),
      label: a.label,
      timing: a.timing,
      phase: a.phase,
    })),
    phases: tactical.phases,
    showZones: true,
    showCallouts: true,
  };
}

/**
 * Get the list of known callout names for a map (loaded from JSON data).
 * Returns an array of lowercase callout names.
 */
export function getCalloutNames(mapName: string): string[] {
  const data = loadMapData(mapName);
  if (!data) return [];
  return data.callouts.map((c) => c.name.toLowerCase());
}

/**
 * Get the raw map data (for external use).
 */
export function getMapData(mapName: string): MapData | null {
  return loadMapData(mapName);
}

/**
 * Extract tactical data from the LLM's free-text response using
 * heuristic regex patterns (French and English).
 *
 * This is a fallback when the focused extraction LLM cannot produce usable
 * structured data but the coaching answer still names concrete callouts.
 *
 * Strategy:
 *  1. Load the map's known callouts.
 *  2. Find callout mentions in the text.
 *  3. Use surrounding context to classify as player position, utility target, etc.
 *  4. Build a TacticalData object with whatever was extracted.
 *
 * Returns null if fewer than 1 callout is found (nothing useful to show).
 */
export function extractTacticalFromText(
  response: string,
  mapName: string
): TacticalData | null {
  const data = loadMapData(mapName);
  if (!data || data.callouts.length === 0) return null;

  // Build a lookup: lowercase name → canonical name
  const calloutLookup = new Map<string, string>();
  for (const c of data.callouts) {
    calloutLookup.set(c.name.toLowerCase(), c.name);
  }

  const players: TacticalData["players"] = [];
  const utility: TacticalData["utility"] = [];
  const arrows: TacticalData["arrows"] = [];
  const lines = response.split("\n");

  // ---- Detect the side (CT or T) ----
  const lowerResp = response.toLowerCase();
  const isT =
    /\b(t\s*side|terrorist|terro|attack|attaquant|execute|rush|default\s+t|side\s+t)\b/i.test(
      lowerResp
    ) ||
    /\b(start|début|round)\b.*\b(t\b|terrorist)/i.test(lowerResp);
  const isCT =
    /\b(ct\s*side|counter|counter-terrorist|retake|défense|défendre)\b/i.test(
      lowerResp
    );
  // If neither is clearly detected, check the question context or default to T
  // (most "donne moi un start" questions are T-side executes)
  const side: "CT" | "T" = isCT && !isT ? "CT" : "T";

  // ---- Player position detection ----
  // Patterns (French + English):
  //   "**Joueur 1** : va vers Cave" / "Joueur 1 : Cave" / "**Joueur 1 :** Cave"
  //   "Player 1: goes to Cave" / "Player 1: Cave"
  //   "J1 : Cave" / "P1 : Cave"
  //   "- Joueur 1 :" ... "position ... Cave"
  //   "J1 -> Cave" / "P1 -> Cave"
  // The pattern handles optional markdown bold (**), bold+colon, and various separators
  const playerLinePattern =
    /\*{0,2}\s*(?:joueur|player|j|p)\s*(\d+)\s*\*{0,2}\s*[:\-–)>]+\s*(.*?)(?:\n|$)/gi;

  for (const line of lines) {
    const m = Array.from(line.matchAll(playerLinePattern));
    if (m.length === 0) continue;

    for (const match of m) {
      const playerNum = parseInt(match[1], 10);
      if (playerNum < 1 || playerNum > 5) continue;
      const rest = match[2].trim();

      // Find callout in the rest of the line
      const callout = findCalloutInText(rest, calloutLookup);
      if (callout) {
        const role = guessRoleFromContext(rest);
        players.push({
          position: callout,
          role,
          team: side,
          timing: guessTimingFromContext(rest),
          task: summarizeTask(rest),
        });

        // Also try to detect movement arrow from "va vers X" / "advances to X"
        const moveTo = findMovementTarget(rest, calloutLookup);
        if (moveTo && moveTo !== callout) {
          arrows.push({
            from: callout,
            to: moveTo,
            type: "movement",
            timing: guessTimingFromContext(rest),
            phase: guessPhaseFromContext(rest),
            label: summarizeTask(rest),
          });
        }
      }
    }
  }

  // ---- Utility detection (full-text scan) ----
  // French: "smoke sur [callout]", "flash par-dessus [callout]", "molotov dans [callout]"
  //   "lance un(e) smoke/flash/molotov/he sur/vers/dans/à [callout]"
  //   "smoke ... depuis [callout] sur [callout]"
  // English: "smoke on [callout]", "flash over [callout]", "molotov in [callout]"
  //   "throw a smoke/flash/molotov/he to/towards/at [callout]"
  const utilityPatterns: Array<{
    type: string;
    pattern: RegExp;
    captureGroup: number;
  }> = [
    // "smoke sur/vers/dans/à [callout]" or "smoke on/to/in/at [callout]"
    {
      type: "smoke",
      pattern:
        /\b(?:smoke|smokes?)\s+(?:sur|vers|dans|à|pour|on|to|in|at|towards?|for)\s+(?:le\s+|la\s+|les?\s+)?([^\s,;.!?()]+)/gi,
      captureGroup: 1,
    },
    // "flash sur/par-dessus/vers [callout]" or "flash over/to/towards [callout]"
    {
      type: "flash",
      pattern:
        /\b(?:flash|flashes?)\s+(?:sur|par[- ]dessus|vers|dans|à|pour|on|over|to|in|at|towards?|for)\s+(?:le\s+|la\s+|les?\s+)?([^\s,;.!?()]+)/gi,
      captureGroup: 1,
    },
    // "molotov dans/sur/vers [callout]" or "molotov in/on/to [callout]"
    {
      type: "molotov",
      pattern:
        /\b(?:molotov|molly|mollies?)\s+(?:dans|sur|vers|à|pour|in|on|to|at|towards?|for)\s+(?:le\s+|la\s+|les?\s+)?([^\s,;.!?()]+)/gi,
      captureGroup: 1,
    },
    // "he grenade / grenade explosive" (less common but handle it)
    {
      type: "he",
      pattern:
        /\b(?:he(?:\s+grenade)?|grenade\s+explosive)\s+(?:sur|vers|dans|à|pour|on|to|in|at|towards?|for)\s+(?:le\s+|la\s+|les?\s+)?([^\s,;.!?()]+)/gi,
      captureGroup: 1,
    },
  ];

  for (const up of utilityPatterns) {
    let uMatch;
    while ((uMatch = up.pattern.exec(lowerResp)) !== null) {
      const rawTarget = uMatch[up.captureGroup].trim();
      const target = matchCallout(rawTarget, calloutLookup);
      if (target) {
        // Try to find a "from" position in the surrounding 80 chars before the match
        const before = lowerResp.slice(Math.max(0, uMatch.index - 80), uMatch.index);
        const around = lowerResp.slice(Math.max(0, uMatch.index - 80), Math.min(lowerResp.length, uMatch.index + 120));
        const from = findCalloutInText(before, calloutLookup) || "T Spawn";

        utility.push({
          type: up.type,
          from,
          to: target,
          description: `${up.type} on ${target}`,
          timing: guessTimingFromContext(around),
          purpose: guessUtilityPurpose(around),
        });

        // Add a utility arrow
        arrows.push({
          from,
          to: target,
          type: "utility",
          timing: guessTimingFromContext(around),
          phase: guessPhaseFromContext(around),
          label: `${up.type} ${target}`,
        });
      }
    }
  }

  // ---- Additional arrow detection from movement verbs ----
  // "avance vers X" / "push X" / "rush X" / "rotate vers X" / "go to X" / "move to X"
  const movementPatterns = [
    /\b(?:avance|push|rush|rotate|rotatio[nN]?|go|move|walk|cour[st]?|descend|remonte)\s+(?:vers|to|through|dans|par|through)\s+([^\s,;.!?()]+)/gi,
    /\b(?:depuis|from)\s+([^\s,;.!?()]+)\s+(?:vers|to|jusqu|until)\s+([^\s,;.!?()]+)/gi,
  ];

  for (const mp of movementPatterns) {
    let mMatch;
    while ((mMatch = mp.exec(lowerResp)) !== null) {
      if (mp === movementPatterns[1] && mMatch.length >= 3) {
        // "depuis X vers Y" pattern: two callouts
        const from = matchCallout(mMatch[1], calloutLookup);
        const to = matchCallout(mMatch[2], calloutLookup);
        if (from && to && from !== to) {
          // Avoid duplicates
          if (!arrows.some((a) => a.from === from && a.to === to)) {
            arrows.push({
              from,
              to,
              type: "movement",
              timing: guessTimingFromContext(lowerResp.slice(Math.max(0, mMatch.index - 80), Math.min(lowerResp.length, mMatch.index + 120))),
              phase: guessPhaseFromContext(lowerResp.slice(Math.max(0, mMatch.index - 80), Math.min(lowerResp.length, mMatch.index + 120))),
            });
          }
        }
      } else {
        const target = matchCallout(mMatch[1], calloutLookup);
        if (target) {
          // No "from" detected — these are just destinations
          // Only add if we have a player near that could be the source
        }
      }
    }
  }

  // ---- Deduplicate players by position ----
  const seenPositions = new Set<string>();
  const uniquePlayers = players.filter((p) => {
    const key = p.position.toLowerCase();
    if (seenPositions.has(key)) return false;
    seenPositions.add(key);
    return true;
  });

  // If we couldn't extract players, return null and let getDefaultTactical handle it
  if (uniquePlayers.length === 0) return null;

  // Determine strategy name from text
  const strategy = guessStrategyName(response, side);

  return {
    map: mapName.toLowerCase(),
    side,
    strategy,
    players: uniquePlayers,
    utility: dedupUtility(utility),
    arrows: dedupArrows(arrows),
    phases: inferPhases(response, uniquePlayers, utility, arrows),
  };
}

/**
 * Generate a default tactical layout for a map when text extraction also fails.
 * Places 5 T-side players at common starting positions.
 * Ensures a map is ALWAYS generated when a map name is mentioned.
 */
export function getDefaultTactical(
  mapName: string,
  response: string
): TacticalData | null {
  const data = loadMapData(mapName);
  if (!data || data.callouts.length === 0) return null;

  // Detect side
  const lowerResp = response.toLowerCase();
  const isCT =
    /\b(ct\s*side|counter|counter-terrorist|retake|défense|défendre)\b/i.test(
      lowerResp
    );
  const side: "CT" | "T" = isCT ? "CT" : "T";

  // Determine which callouts to use based on side
  const callouts = data.callouts.map((c) => c.name);

  // Pick 5 spread-out positions for a default layout
  // For T side: use positions near T Spawn, mid, and split paths
  // For CT side: use positions near CT Spawn and sites
  const selectedPositions = selectDefaultPositions(callouts, mapName, side);

  const players: TacticalData["players"] = selectedPositions.map(
    (pos, i) => ({
      position: pos,
      role:
        i === 0
          ? "entry"
          : i === 1
            ? "support"
            : i === 2
              ? "awp"
              : i === 3
                ? "igl"
                : "lurk",
      team: side,
    })
  );

  // Add simple arrows from spawn to first positions
  const spawnName = side === "CT" ? "CT Spawn" : "T Spawn";
  const spawnCallout = callouts.find((c) => c.toLowerCase() === spawnName.toLowerCase());
  const arrows: TacticalData["arrows"] = [];

  if (spawnCallout) {
    // Add arrows from spawn to each player position (max 3 to avoid clutter)
    for (let i = 0; i < Math.min(players.length, 3); i++) {
      if (players[i].position.toLowerCase() !== spawnCallout.toLowerCase()) {
        arrows.push({
          from: spawnCallout,
          to: players[i].position,
          type: "movement",
          timing: i === 0 ? "0:00" : "0:05",
          phase: "Opening",
          label: `${players[i].role} route`,
        });
      }
    }
  }

  const strategy = guessStrategyName(response, side);

  return {
    map: mapName.toLowerCase(),
    side,
    strategy: strategy || `Default ${side} Setup`,
    players,
    utility: [],
    arrows,
    phases: [
      {
        name: "Opening",
        timing: "0:00-0:15",
        description: `${side} players take initial spacing and map control.`,
        callouts: players.map((player) => player.position),
      },
    ],
  };
}

/**
 * Extract tactical data from the chat response using a second focused LLM call.
 * This is the primary extraction method in the two-stage approach:
 *   Stage 1: Chat LLM responds naturally (no tactical JSON)
 *   Stage 2: This function analyzes the response and extracts structured tactical data
 *
 * Falls back to extractTacticalFromText() / getDefaultTactical() if the LLM call fails.
 */
export async function extractTacticalWithLLM(
  chatResponse: string,
  mapName: string
): Promise<TacticalData | null> {
  const data = loadMapData(mapName);
  if (!data || data.callouts.length === 0) return null;

  const calloutNames = data.callouts.map((c) => c.name).join(", ");

  const extractionPrompt = `You are a tactical CS2 map data extractor. Analyze the following CS2 coaching advice and extract structured tactical data from it.

COACHING RESPONSE TO ANALYZE:
${chatResponse.substring(0, 4000)}

MAP: ${data.displayName} (${data.name})
VALID CALLOUTS: ${calloutNames}

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "map": "${mapName}",
  "side": "CT or T",
  "strategy": "brief strategy name",
  "players": [
    {"position": "callout_name", "role": "entry|support|awp|igl|lurk", "team": "CT or T", "timing": "0:00|0:15|mid-round|late", "task": "short player job"}
  ],
  "utility": [
    {"type": "smoke|flash|molotov|he", "from": "callout", "to": "callout", "description": "what it does", "timing": "when to throw", "purpose": "why it matters", "player": "role/player if known"}
  ],
  "arrows": [
    {"from": "callout", "to": "callout", "type": "movement|utility|rotation", "timing": "when", "phase": "Opening|Map control|Execute|Post-plant|Retake", "label": "short route label"}
  ],
  "phases": [
    {"name": "Opening|Map control|Execute|Post-plant|Retake", "timing": "0:00-0:15", "description": "what happens", "callouts": ["callout"]}
  ]
}

RULES:
- Use ONLY callout names from the VALID CALLOUTS list above
- Include up to 5 players (fewer if the text doesn't describe all 5 positions)
- Add timing/phases when implied by the advice; use short labels if exact seconds are not available
- Capture distinct utility purposes: smoke vision block, flash entry, molotov clear/deny, HE damage/chip
- Include rotation/post-plant/retake routes when the advice mentions contingencies
- Detect the side (CT or T) from the coaching advice context
- If no tactical information can be extracted at all, return: {"map": "${mapName}", "side": "T", "strategy": "", "players": [], "utility": [], "arrows": [], "phases": []}
- The JSON must be valid and parsable — no trailing commas`;

  try {
    const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://api.deepseek.com/v1";
    const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OLLAMA_API_KEY || "";
    const LLM_MODEL = process.env.LLM_MODEL || "deepseek-chat";

    const llmResponse = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are a precise data extraction assistant. Extract structured data from text and output only valid JSON.",
          },
          { role: "user", content: extractionPrompt },
        ],
        temperature: 0.1,
        max_tokens: 2048,
      }),
    });

    if (!llmResponse.ok) {
      console.warn(
        `[map-detection] LLM extraction API error: ${llmResponse.status}`
      );
      return null;
    }

    const result = await llmResponse.json();
    const content = result.choices?.[0]?.message?.content;
    if (!content) return null;

    const cleaned = cleanJSONResponse(content);
    const parsed = tryParseTactical(cleaned);
    if (parsed) {
      if (!hasTacticalDetails(parsed)) {
        console.log("[map-detection] LLM extraction returned empty tactical data; falling back");
        return null;
      }
      console.log(
        `[map-detection] LLM extraction succeeded: ${parsed.players.length} players, ${parsed.utility.length} utility`
      );
      return parsed;
    }

    return null;
  } catch (error) {
    console.error("[map-detection] Error in extractTacticalWithLLM:", error);
    return null;
  }
}

function cleanJSONResponse(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    if (firstNewline > -1) {
      cleaned = cleaned.slice(firstNewline + 1);
    } else {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith("```")) {
      cleaned = cleaned.slice(0, -3);
    }
  }
  return cleaned.trim();
}

// ---------------------------------------------------------------------------
// Helper functions for text extraction
// ---------------------------------------------------------------------------

/**
 * Find the first known callout name in a text fragment.
 * Matches case-insensitively against the canonical callout names.
 */
function findCalloutInText(
  text: string,
  calloutLookup: Map<string, string>
): string | null {
  const lower = text.toLowerCase();

  // Find the earliest callout match in the text (by position, not by name length).
  // This ensures "va vers A Main, ... smoke sur CT Lane" picks "A Main" first.
  // When two callouts start at the same position, prefer the longer one.
  let bestMatch: string | null = null;
  let bestIndex = Infinity;
  let bestLength = 0;

  Array.from(calloutLookup.entries()).forEach(([key, value]) => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const regex = new RegExp(`\\b${escaped}\\b`, "i");
    const m = lower.match(regex);
    if (m && m.index !== undefined) {
      if (m.index < bestIndex || (m.index === bestIndex && key.length > bestLength)) {
        bestIndex = m.index;
        bestLength = key.length;
        bestMatch = value;
      }
    }
  });

  return bestMatch;
}

/**
 * Try to match a single word/phrase against known callouts.
 * Handles case differences and partial matches.
 */
function matchCallout(
  text: string,
  calloutLookup: Map<string, string>
): string | null {
  const lower = text.toLowerCase().trim();

  // Direct match
  if (calloutLookup.has(lower)) {
    return calloutLookup.get(lower)!;
  }

  // Try removing common French articles
  const withoutArticle = lower.replace(/^(le|la|les?|un|une|des?)\s+/i, "");
  if (calloutLookup.has(withoutArticle)) {
    return calloutLookup.get(withoutArticle)!;
  }

  // Fuzzy: check if any callout starts with the text or vice versa
  let returnStr: string | null = null;
  let bestLength = 0;
  Array.from(calloutLookup.entries()).forEach(([key, value]) => {
    const allowShortAlias = key.length >= 3 || lower.length <= 2;
    if (allowShortAlias && (key.startsWith(lower) || lower.startsWith(key)) && key.length > bestLength) {
      returnStr = value;
      bestLength = key.length;
    }
  });
  return returnStr;
}

/**
 * Find a movement target from text like "va vers Cave" / "goes to Long".
 */
function findMovementTarget(
  text: string,
  calloutLookup: Map<string, string>
): string | null {
  const movementPattern =
    /\b(?:va\s+(?:vers|à|dans|en)|go(?:es)?\s+(?:to|through|into)|advances?\s+(?:to|towards)|push(?:es)?\s+(?:to|through)?|rushing?)\s+([^\s,;.!?()]+)/gi;

  let m;
  while ((m = movementPattern.exec(text)) !== null) {
    const target = matchCallout(m[1], calloutLookup);
    if (target) return target;
  }

  return null;
}

/**
 * Guess player role from the context of their position description.
 */
function guessRoleFromContext(text: string): string {
  const lower = text.toLowerCase();
  if (
    /entry|fragger|premier|first|rush/i.test(lower) ||
    /entrée|premier/i.test(lower)
  )
    return "entry";
  if (
    /support|anchor|supporter|couverture/i.test(lower)
  )
    return "support";
  if (/awp|sniper|snipe|scope/i.test(lower)) return "awp";
  if (/igl|caller|lead|leader|capitaine/i.test(lower)) return "igl";
  if (
    /lurk|flank|flankeur|rotate|rotation|latéral/i.test(lower)
  )
    return "lurk";
  return "support";
}

function guessTimingFromContext(text: string): string | undefined {
  const explicit = text.match(/\b(?:\d{1,2}:\d{2}|\d{1,2}\s?s|\d{1,2}\s?sec(?:ondes?)?)\b/i);
  if (explicit) return explicit[0].replace(/\s+/g, "");

  const lower = text.toLowerCase();
  if (/freeze|spawn|début|start|opening|premi[eè]res?/i.test(lower)) return "0:00";
  if (/mid[-\s]?round|milieu|tempo|attendre|wait/i.test(lower)) return "mid-round";
  if (/late|fin|end[-\s]?round|retake|post[-\s]?plant/i.test(lower)) return "late";
  if (/execute|exec|go|contact|pop/i.test(lower)) return "execute";
  return undefined;
}

function guessPhaseFromContext(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (/retake|reprise/i.test(lower)) return "Retake";
  if (/post[-\s]?plant|après plant/i.test(lower)) return "Post-plant";
  if (/execute|exec|go|pop/i.test(lower)) return "Execute";
  if (/default|control|contrôle|map control/i.test(lower)) return "Map control";
  if (/rotate|rotation|late|fin/i.test(lower)) return "Rotation";
  return undefined;
}

function guessUtilityPurpose(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (/block|bloque|coupe|isolate|isoler|vision|ligne/i.test(lower)) return "Block vision";
  if (/clear|netto|deny|empêche|anti[-\s]?rush|molotov/i.test(lower)) return "Clear or deny space";
  if (/flash|blind|aveugl/i.test(lower)) return "Blind defenders for entry";
  if (/retake|reprise/i.test(lower)) return "Retake support";
  return undefined;
}

function summarizeTask(text: string): string | undefined {
  const cleaned = text
    .replace(/[*_`#>-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > 42 ? `${cleaned.slice(0, 41)}…` : cleaned;
}

function inferPhases(
  response: string,
  players: TacticalData["players"],
  utility: TacticalData["utility"],
  arrows: TacticalData["arrows"]
): TacticalData["phases"] {
  const phases: NonNullable<TacticalData["phases"]> = [];
  const lower = response.toLowerCase();

  if (players.length > 0) {
    phases.push({
      name: "Opening",
      timing: "0:00-0:15",
      description: "Initial spacing and role assignments.",
      callouts: players.map((player) => player.position).slice(0, 5),
    });
  }

  if (utility.length > 0 || /execute|exec|go|pop/i.test(lower)) {
    phases.push({
      name: "Execute",
      timing: "execute",
      description: "Commit with the listed utility and trade paths.",
      callouts: utility.map((util) => util.to).slice(0, 5),
    });
  }

  if (arrows.some((arrow) => arrow.type === "rotation") || /rotate|rotation|retake|post[-\s]?plant/i.test(lower)) {
    phases.push({
      name: /retake|reprise/i.test(lower) ? "Retake" : "Rotation",
      timing: /late|fin|post[-\s]?plant/i.test(lower) ? "late" : "mid-round",
      description: "Fallback, rotation, or retake route if the first plan stalls.",
      callouts: arrows.flatMap((arrow) => [arrow.from, arrow.to]).slice(0, 6),
    });
  }

  return phases;
}

/**
 * Guess strategy name from the response text.
 */
function guessStrategyName(response: string, side: "CT" | "T"): string {
  const lower = response.toLowerCase();

  // Check for common strategy keywords
  if (/default/i.test(lower) && /execute/i.test(lower))
    return "Default Execute";
  if (/rush/i.test(lower)) return "Rush";
  if (/slow\s*push|methodical/i.test(lower)) return "Slow Push";
  if (/split/i.test(lower)) return "Split Push";
  if (/execute/i.test(lower)) return "Execute";
  if (/retake/i.test(lower)) return "Retake";
  if (/stack|anchor|hold/i.test(lower)) return "Site Hold";
  if (/push/i.test(lower)) return "Push";
  if (/rotate|rotation/i.test(lower)) return "Rotation";
  if (/fast/i.test(lower)) return "Fast Play";

  // Check for specific site mentions
  if (/site\s*a|a\s*rush|push\s*a|execute\s*a/i.test(lower))
    return "A Execute";
  if (/site\s*b|b\s*rush|push\s*b|execute\s*b/i.test(lower))
    return "B Execute";
  if (/mid/i.test(lower)) return "Mid Control";

  return `${side} Strategy`;
}

/**
 * Select default positions for a 5-player setup on a given map.
 * Uses map-specific knowledge for common default positions.
 */
function selectDefaultPositions(
  callouts: string[],
  mapName: string,
  side: "CT" | "T"
): string[] {
  // Map-specific default positions
  const mapDefaults: Record<string, Record<string, string[]>> = {
    ancient: {
      T: ["A Main", "Mid", "Tunnel", "Stairs", "Split"],
      CT: ["A Site", "B Site", "Connector", "CT Spawn", "Cave"],
    },
    dust2: {
      T: ["T Spawn", "Upper Tunnel", "Long Doors", "Catwalk", "Mid Doors"],
      CT: ["A Site", "B Site", "CT Mid", "CT Spawn", "B Tunnels"],
    },
    mirage: {
      T: ["T Spawn", "A Ramp", "B Apartments", "Mid", "Palace"],
      CT: ["A Site", "B Site", "CT Spawn", "Jungle", "Market"],
    },
    inferno: {
      T: ["T Spawn", "Banana", "Mid", "Apartments", "T Apartments"],
      CT: ["A Site", "B Site", "CT Spawn", "Library", "Construction"],
    },
    anubis: {
      T: ["T Spawn", "A Main", "B Main", "Mid", "Canal"],
      CT: ["A Site", "B Site", "CT Spawn", "Connector", "Palace"],
    },
    nuke: {
      T: ["T Spawn", "Lobby", "Secret", "Yard", "Vent"],
      CT: ["A Site", "B Site", "CT Spawn", "Ramp", "Heaven"],
    },
    overpass: {
      T: ["T Spawn", "A Long", "B Short", "Mid", "Playground"],
      CT: ["A Site", "B Site", "CT Spawn", "Connector", "Water"],
    },
    vertigo: {
      T: ["T Spawn", "A Ramp", "B Ramp", "Mid", "Stairs"],
      CT: ["A Site", "B Site", "CT Spawn", "Mid", "Pillar"],
    },
  };

  const defaults = mapDefaults[mapName]?.[side];
  if (defaults) {
    // Filter to only include callouts that actually exist in the map data
    const calloutSet = new Set(callouts.map((c) => c.toLowerCase()));
    const valid = defaults.filter((d) => calloutSet.has(d.toLowerCase()));
    if (valid.length >= 3) {
      // Pad to 5 if needed using T Spawn / CT Spawn
      while (valid.length < 5 && valid.length < callouts.length) {
        const next = callouts.find(
          (c) => !valid.some((v) => v.toLowerCase() === c.toLowerCase())
        );
        if (next) valid.push(next);
        else break;
      }
      return valid.slice(0, 5);
    }
  }

  // Generic fallback: pick first 5 callouts that aren't spawns
  const nonSpawn = callouts.filter(
    (c) =>
      !c.toLowerCase().includes("spawn") &&
      c.toLowerCase() !== "mid"
  );
  const spawn = callouts.find((c) =>
    c.toLowerCase().includes(side === "T" ? "t spawn" : "ct spawn")
  );

  const result: string[] = [];
  if (spawn) result.push(spawn);
  for (const c of nonSpawn) {
    if (result.length >= 5) break;
    if (!result.some((r) => r.toLowerCase() === c.toLowerCase())) {
      result.push(c);
    }
  }

  return result.slice(0, 5);
}

/**
 * Deduplicate utility entries.
 */
function dedupUtility(
  utility: TacticalData["utility"]
): TacticalData["utility"] {
  const seen = new Set<string>();
  return utility.filter((u) => {
    const key = `${u.type}:${u.from}:${u.to}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Deduplicate arrow entries.
 */
function dedupArrows(
  arrows: TacticalData["arrows"]
): TacticalData["arrows"] {
  const seen = new Set<string>();
  return arrows.filter((a) => {
    const key = `${a.from}:${a.to}:${a.type}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
