import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlayerMarker {
  position: string; // callout name
  role: "entry" | "support" | "awp" | "igl" | "lurk";
  team: "CT" | "T";
  label?: string;
  timing?: string;
  task?: string;
  phase?: string;
}

export interface UtilityMarker {
  type: "smoke" | "flash" | "molotov" | "he";
  from: string; // callout name
  to: string; // callout name
  label?: string;
  timing?: string;
  purpose?: string;
  player?: string;
  phase?: string;
}

export interface Arrow {
  from: string; // callout name
  to: string; // callout name
  type: "push" | "throw";
  color?: string;
  label?: string;
  timing?: string;
  phase?: string;
}

export interface PhaseNote {
  name: string;
  timing?: string;
  description?: string;
  callouts?: string[];
}

export interface TacticalMapOptions {
  mapName: string;
  side?: "CT" | "T";
  title?: string;
  players?: PlayerMarker[];
  utility?: UtilityMarker[];
  arrows?: Arrow[];
  phases?: PhaseNote[];
  showZones?: boolean;
  showCallouts?: boolean;
}

// ---------------------------------------------------------------------------
// Map data shape (matches the JSON files)
// ---------------------------------------------------------------------------

interface Coord {
  x: number;
  y: number;
}

interface Callout {
  name: string;
  x: number;
  y: number;
  zone?: string;
  description?: string;
}

interface Zone {
  name: string;
  polygon: number[][];
  centroid: Coord;
  type: string;
}

interface MapData {
  name: string;
  displayName?: string;
  viewBox: number[];
  sites: Record<string, Coord>;
  spawns: { CT: Coord; T: Coord };
  callouts: Callout[];
  zones: Zone[];
}

interface LoadedMap {
  data: MapData;
  baseSvg: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Coordinates in JSON are 0-1000. Base SVG is 0-1024. */
const SCALE = 1.024;

/** Base map SVG dimensions. */
const MAP_SIZE = 1024;

/** Padding added around the map so scaled annotations (callouts, arrows) are not clipped. */
const MAP_PAD = 80;

/** Effective viewBox size (map + padding on all sides). */
const VIEW_SIZE = MAP_SIZE + MAP_PAD * 2;

/** Annotation scale relative to the base radar image. */
const ANNOTATION_SCALE = 1.65;
const PHASE_CAP = 8;
const TACTICAL_FONT = "'JetBrains Mono', monospace";
const TEXT_HALO = 'paint-order="stroke" stroke="rgba(0,0,0,0.88)" stroke-width="3" stroke-linejoin="round"';
const SMALL_TEXT_HALO = 'paint-order="stroke" stroke="rgba(0,0,0,0.82)" stroke-width="2" stroke-linejoin="round"';

const PHASE_ORDER = [
  "Opening",
  "Map control",
  "Execute",
  "Post-plant",
  "Retake",
  "Rotation",
] as const;

type PhaseType = "opening" | "map-control" | "execute" | "post-plant" | "retake" | "rotation" | "custom";

interface PhaseMeta {
  index: number;
  name: string;
  type: PhaseType;
}

const ROLE_LETTER: Record<string, string> = {
  entry: "E",
  support: "S",
  awp: "A",
  igl: "I",
  lurk: "L",
};

const TEAM_COLORS: Record<string, { fill: string; stroke: string }> = {
  CT: { fill: "#4FC3F7", stroke: "white" },
  T: { fill: "#EF5350", stroke: "white" },
};

const UTILITY_STYLE: Record<
  string,
  { fill: string; letter: string; shape: "circle" | "star" | "diamond" | "hex"; name: string }
> = {
  smoke: { fill: "#9E9E9E", letter: "S", shape: "circle", name: "Smoke" },
  flash: { fill: "#FFD600", letter: "F", shape: "star", name: "Flash" },
  molotov: { fill: "#FF9800", letter: "M", shape: "diamond", name: "Molotov" },
  he: { fill: "#F44336", letter: "H", shape: "hex", name: "HE Grenade" },
};

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

const mapCache = new Map<string, LoadedMap>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sx(v: number): number {
  return v * SCALE;
}
function sy(v: number): number {
  return v * SCALE;
}

function annotationSize(v: number): number {
  return v * ANNOTATION_SCALE;
}

function dashPattern(a: number, b: number): string {
  return `${annotationSize(a)},${annotationSize(b)}`;
}

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function compact(parts: Array<string | undefined | null>): string[] {
  return parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
}

function tooltip(parts: Array<string | undefined | null>): string {
  return compact(parts).join(" · ");
}

function phaseTypeFromText(value: string | undefined | null): PhaseType {
  const lower = value?.toLowerCase().trim() || "";
  if (!lower) return "custom";
  if (/retake|reprise|defuse/.test(lower)) return "retake";
  if (/post[-\s]?plant|after\s+plant|après\s+plant|apres\s+plant/.test(lower)) return "post-plant";
  if (/execute|exec|commit|explode|go\s+signal|pop|contact/.test(lower)) return "execute";
  if (/map\s*control|control|contrôle|controle|default|mid[-\s]?round|take\s+space|pressure/.test(lower)) return "map-control";
  if (/rotate|rotation|fallback|regroup|pivot|late[-\s]?round/.test(lower)) return "rotation";
  if (/opening|spawn|freeze|start|début|debut|initial|first\s+contact|0:00/.test(lower)) return "opening";
  return "custom";
}

function canonicalPhaseName(value: string | undefined | null): string | undefined {
  const type = phaseTypeFromText(value);
  if (type === "custom") return value?.trim() || undefined;
  const canonical = PHASE_ORDER.find((phase) => phaseTypeFromText(phase) === type);
  return canonical || value?.trim() || undefined;
}

function phaseOrderIndex(phase: PhaseNote): number {
  const type = phaseTypeFromText(phase.name);
  const index = PHASE_ORDER.findIndex((name) => phaseTypeFromText(name) === type);
  return index >= 0 ? index : PHASE_ORDER.length;
}

function normalizePhases(phases: PhaseNote[] | undefined): PhaseMeta[] {
  const seen = new Set<string>();
  return (phases || [])
    .map((phase) => ({
      ...phase,
      name: canonicalPhaseName(phase.name) || phase.name,
    }))
    .filter((phase) => {
      const name = phase.name.trim();
      if (!name) return false;
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => phaseOrderIndex(a) - phaseOrderIndex(b))
    .slice(0, PHASE_CAP)
    .map((phase, index) => ({
      index,
      name: phase.name,
      type: phaseTypeFromText(phase.name),
    }));
}

function phaseMetaFor(
  phases: PhaseMeta[],
  hints: Array<string | undefined | null>,
  fallbackName: string
): PhaseMeta | null {
  if (phases.length === 0) return null;
  const names = compact([...hints, fallbackName]);
  for (const name of names) {
    const canonical = canonicalPhaseName(name) || name;
    const type = phaseTypeFromText(canonical);
    const exact = phases.find((phase) => phase.name.toLowerCase() === canonical.toLowerCase());
    if (exact) return exact;
    if (type !== "custom") {
      const byType = phases.find((phase) => phase.type === type);
      if (byType) return byType;
    }
  }
  return phases[0];
}

function phaseAttrs(meta: PhaseMeta | null): string {
  if (!meta) return "";
  return `data-tm-phase-index="${meta.index}" data-tm-phase-name="${escXml(meta.name)}" data-tm-phase-type="${meta.type}"`;
}

function roleLabel(role: PlayerMarker["role"]): string {
  const labels: Record<PlayerMarker["role"], string> = {
    entry: "Entry",
    support: "Support",
    awp: "AWP",
    igl: "IGL",
    lurk: "Lurker",
  };
  return labels[role];
}

function labelText(parts: Array<string | undefined | null>, maxLength = 34): string {
  const joined = compact(parts).join(" · ");
  return joined.length > maxLength ? `${joined.slice(0, maxLength - 1)}…` : joined;
}

function starPoints(cx: number, cy: number, outerR: number, innerR: number, points: number): string {
  const coords: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const angle = (Math.PI / points) * i - Math.PI / 2;
    const r = i % 2 === 0 ? outerR : innerR;
    coords.push(`${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`);
  }
  return coords.join(" ");
}

function regularPolygonPoints(cx: number, cy: number, radius: number, points: number, offset = -Math.PI / 2): string {
  const coords: string[] = [];
  for (let i = 0; i < points; i++) {
    const angle = offset + (2 * Math.PI * i) / points;
    coords.push(`${cx + radius * Math.cos(angle)},${cy + radius * Math.sin(angle)}`);
  }
  return coords.join(" ");
}

// ---------------------------------------------------------------------------
// 1. loadMap
// ---------------------------------------------------------------------------

export function loadMap(mapName: string): LoadedMap {
  const cached = mapCache.get(mapName);
  if (cached) return cached;

  const jsonPath = path.join(
    process.cwd(),
    "data",
    "maps",
    `${mapName}.json`
  );
  const localBaseSvgPath = path.join(process.cwd(), "data", "map-svgs", `${mapName}.svg`);
  const envBaseSvgPath = process.env.CS_MAP_SVG_DIR
    ? path.join(process.env.CS_MAP_SVG_DIR, `${mapName}.svg`)
    : null;
  const legacyBaseSvgPath = path.join(
    process.cwd(),
    "..",
    "..",
    "zob",
    "cs-zob-v1",
    "map",
    `${mapName}.svg`
  );
  const baseSvgPath = [localBaseSvgPath, envBaseSvgPath, legacyBaseSvgPath].find(
    (candidate): candidate is string => Boolean(candidate && fs.existsSync(candidate))
  );

  if (!baseSvgPath) {
    throw new Error(`Base SVG not found for map: ${mapName}`);
  }

  const rawJson = fs.readFileSync(jsonPath, "utf-8");
  const data: MapData = JSON.parse(rawJson);

  const baseSvg = fs.readFileSync(baseSvgPath, "utf-8");

  const loaded: LoadedMap = { data, baseSvg };
  mapCache.set(mapName, loaded);
  return loaded;
}

// ---------------------------------------------------------------------------
// 3. resolveCallout
// ---------------------------------------------------------------------------

export function resolveCallout(
  mapName: string,
  calloutName: string
): Coord | null {
  const { data } = loadMap(mapName);
  const lower = calloutName.toLowerCase();

  // Search callouts (case-insensitive)
  const callout = data.callouts.find(
    (c) => c.name.toLowerCase() === lower
  );
  if (callout) return { x: callout.x, y: callout.y };

  // Also check site names
  for (const [key, coord] of Object.entries(data.sites)) {
    if (key.toLowerCase() === lower) return coord;
  }

  // Check spawns
  if (lower === "ct spawn" || lower === "ct") return data.spawns.CT;
  if (lower === "t spawn" || lower === "t") return data.spawns.T;

  // Partial match fallback
  const partial = data.callouts.find(
    (c) => c.name.toLowerCase().includes(lower) || lower.includes(c.name.toLowerCase())
  );
  if (partial) return { x: partial.x, y: partial.y };

  return null;
}

// ---------------------------------------------------------------------------
// 2. renderTacticalMap
// ---------------------------------------------------------------------------

export function renderTacticalMap(options: TacticalMapOptions): string {
  const { mapName } = options;
  const loaded = loadMap(mapName);
  const { data, baseSvg } = loaded;

  // Strip the outer <svg> tag from the base to rebuild it with tactical overlays.
  // The base SVG has viewBox="0 0 1024 1024" width="1024" height="1024"
  // We extract only the inner content
  const innerContent = baseSvg
    .replace(/<\?xml[^?]*\?>\s*/g, "") // Remove XML declaration
    .replace(/<svg[^>]*>/, "")          // Remove opening <svg> tag
    .replace(/<\/svg>\s*$/, "");        // Remove closing </svg>

  const overlays: string[] = [];
  const phaseItems = normalizePhases(options.phases);

  // -- Defs for arrowhead markers --
  overlays.push(`
  <defs>
    <marker id="arrowPush" markerWidth="16" markerHeight="12" refX="15" refY="6" orient="auto">
      <polygon points="0 0, 16 6, 0 12" fill="#FFFFFF"/>
    </marker>
    <marker id="arrowThrow" markerWidth="16" markerHeight="12" refX="15" refY="6" orient="auto">
      <polygon points="0 0, 16 6, 0 12" fill="#FFD600"/>
    </marker>
  </defs>`);

  // -- Semi-transparent background for overlays --
  overlays.push(
    `<rect x="0" y="0" width="${MAP_SIZE}" height="${MAP_SIZE}" fill="black" opacity="0.15"/>`
  );

  // -- Zone polygons --
  if (options.showZones) {
    for (const zone of data.zones) {
      const polyPoints = zone.polygon
        .map(([px, py]) => `${sx(px)},${sy(py)}`)
        .join(" ");

      const zoneColors: Record<string, string> = {
        site: "rgba(255,200,0,0.055)",
        spawn: "rgba(100,100,255,0.045)",
        connector: "rgba(100,255,100,0.04)",
        area: "rgba(200,200,200,0.03)",
      };
      const fillColor = zoneColors[zone.type] || "rgba(200,200,200,0.03)";
      const zoneAttrs = `data-tm-type="zone" data-tm-callout="${escXml(zone.name)}" data-tm-tooltip="${escXml(zone.name)}" class="tm-zone"`;

      overlays.push(
        `<polygon ${zoneAttrs} points="${polyPoints}" fill="${fillColor}" stroke="rgba(255,255,255,0.12)" stroke-width="${annotationSize(0.75)}"/>`
      );

      // Zone label at centroid
      const cx = sx(zone.centroid.x);
      const cy = sy(zone.centroid.y);
      overlays.push(
        `<text data-tm-type="zone" class="tm-zone" x="${cx}" y="${cy}" font-size="${annotationSize(7)}" fill="rgba(255,255,255,0.28)" text-anchor="middle" dominant-baseline="middle" font-family="${TACTICAL_FONT}">${escXml(zone.name)}</text>`
      );
    }
  }

  // -- Callout labels --
  if (options.showCallouts) {
    for (const c of data.callouts) {
      const cx = sx(c.x);
      const cy = sy(c.y);
      overlays.push(
        `<text data-tm-type="zone" data-tm-tooltip="${escXml(c.name)}" class="tm-zone" x="${cx}" y="${cy + annotationSize(20)}" font-size="${annotationSize(6.5)}" fill="rgba(255,255,255,0.24)" text-anchor="middle" font-family="${TACTICAL_FONT}">${escXml(c.name)}</text>`
      );
    }
  }

  // -- Arrows (behind markers) --
  if (options.arrows) {
    for (const arrow of options.arrows) {
      const fromCoord = resolveCallout(mapName, arrow.from);
      const toCoord = resolveCallout(mapName, arrow.to);
      if (!fromCoord || !toCoord) continue;

      const x1 = sx(fromCoord.x);
      const y1 = sy(fromCoord.y);
      const x2 = sx(toCoord.x);
      const y2 = sy(toCoord.y);

      const isThrow = arrow.type === "throw";
      const strokeColor = arrow.color || (isThrow ? "#FFD600" : "#FFFFFF");
      const dashArray = isThrow ? `stroke-dasharray="${dashPattern(9, 5)}"` : "";
      const markerEnd = isThrow ? 'marker-end="url(#arrowThrow)"' : 'marker-end="url(#arrowPush)"';
      const phaseMeta = phaseMetaFor(phaseItems, [arrow.phase, arrow.timing, arrow.label, arrow.type], isThrow ? "Execute" : "Map control");
      const phaseAttrText = phaseAttrs(phaseMeta);
      const arrowLabel = labelText([phaseMeta ? `${phaseMeta.index + 1}. ${phaseMeta.name}` : arrow.phase, arrow.timing, arrow.label], 38);
      const arrowTooltip = tooltip([
        isThrow ? "Throw route" : "Movement route",
        phaseMeta ? `${phaseMeta.index + 1}. ${phaseMeta.name}` : arrow.phase,
        arrow.timing,
        arrow.label,
        `${arrow.from} → ${arrow.to}`,
      ]);

      overlays.push(
        `<line data-tm-type="arrow" ${phaseAttrText} data-tm-tooltip="${escXml(arrowTooltip)}" class="tm-arrow" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(0,0,0,0.74)" stroke-width="${annotationSize(6)}" ${dashArray} stroke-linecap="round" opacity="0.9"/>`
      );
      overlays.push(
        `<line data-tm-type="arrow" ${phaseAttrText} data-tm-tooltip="${escXml(arrowTooltip)}" class="tm-arrow" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${strokeColor}" stroke-width="${annotationSize(3.6)}" ${dashArray} ${markerEnd} stroke-linecap="round" opacity="0.97"/>`
      );

      if (arrowLabel) {
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        overlays.push(
          `<text data-tm-type="arrow" ${phaseAttrText} data-tm-tooltip="${escXml(arrowTooltip)}" class="tm-arrow" x="${mx}" y="${my - annotationSize(8)}" font-size="${annotationSize(10.5)}" font-weight="800" fill="${strokeColor}" ${SMALL_TEXT_HALO} text-anchor="middle" font-family="${TACTICAL_FONT}">${escXml(arrowLabel)}</text>`
        );
      }
    }
  }

  // -- Utility markers --
  if (options.utility) {
    for (const util of options.utility) {
      const fromCoord = resolveCallout(mapName, util.from);
      const toCoord = resolveCallout(mapName, util.to);
      if (!toCoord) continue;

      const tx = sx(toCoord.x);
      const ty = sy(toCoord.y);
      const style = UTILITY_STYLE[util.type] || UTILITY_STYLE.smoke;
      const r = annotationSize(13.5);
      const utilName = style.name;
      const phaseMeta = phaseMetaFor(phaseItems, [util.phase, util.timing, util.purpose, util.label], "Execute");
      const phaseAttrText = phaseAttrs(phaseMeta);
      const utilLabel = labelText([phaseMeta ? `${phaseMeta.index + 1}. ${phaseMeta.name}` : util.phase, util.timing, util.label || util.purpose], 38);
      const utilTooltip = tooltip([
        utilName,
        phaseMeta ? `${phaseMeta.index + 1}. ${phaseMeta.name}` : util.phase,
        util.timing,
        util.player,
        util.purpose || util.label,
        `${util.from} → ${util.to}`,
      ]);
      const utilAttrs = `data-tm-type="utility" ${phaseAttrText} data-tm-utility-type="${escXml(utilName)}" data-tm-tooltip="${escXml(utilTooltip)}" class="tm-utility"`;

      // Throw trajectory line
      if (fromCoord) {
        const fx = sx(fromCoord.x);
        const fy = sy(fromCoord.y);
        overlays.push(
          `<line ${utilAttrs} x1="${fx}" y1="${fy}" x2="${tx}" y2="${ty}" stroke="rgba(0,0,0,0.7)" stroke-width="${annotationSize(4.2)}" stroke-dasharray="${dashPattern(5, 4)}" stroke-linecap="round" opacity="0.85"/>`
        );
        overlays.push(
          `<line ${utilAttrs} x1="${fx}" y1="${fy}" x2="${tx}" y2="${ty}" stroke="${style.fill}" stroke-width="${annotationSize(2.4)}" stroke-dasharray="${dashPattern(5, 4)}" stroke-linecap="round" opacity="0.9"/>`
        );
      }

      // Shape
      if (style.shape === "star") {
        const pts = starPoints(tx, ty, r, r * 0.45, 5);
        overlays.push(
          `<polygon ${utilAttrs} points="${pts}" fill="${style.fill}" stroke="white" stroke-width="${annotationSize(1.8)}" opacity="0.98"/>`
        );
      } else if (style.shape === "diamond") {
        const pts = regularPolygonPoints(tx, ty, r, 4, -Math.PI / 2);
        overlays.push(
          `<polygon ${utilAttrs} points="${pts}" fill="${style.fill}" stroke="white" stroke-width="${annotationSize(1.8)}" opacity="0.98"/>`
        );
      } else if (style.shape === "hex") {
        const pts = regularPolygonPoints(tx, ty, r, 6);
        overlays.push(
          `<polygon ${utilAttrs} points="${pts}" fill="${style.fill}" stroke="white" stroke-width="${annotationSize(1.8)}" opacity="0.98"/>`
        );
      } else {
        overlays.push(
          `<circle ${utilAttrs} cx="${tx}" cy="${ty}" r="${r}" fill="${style.fill}" stroke="white" stroke-width="${annotationSize(1.8)}" opacity="0.98"/>`
        );
      }

      // Letter
      overlays.push(
        `<text ${utilAttrs} x="${tx}" y="${ty + annotationSize(1)}" font-size="${annotationSize(13)}" font-weight="900" fill="white" ${SMALL_TEXT_HALO} text-anchor="middle" dominant-baseline="middle" font-family="${TACTICAL_FONT}">${style.letter}</text>`
      );

      // Optional label
      if (utilLabel) {
        overlays.push(
          `<text ${utilAttrs} x="${tx}" y="${ty - annotationSize(18)}" font-size="${annotationSize(9.5)}" font-weight="800" fill="white" ${TEXT_HALO} text-anchor="middle" font-family="${TACTICAL_FONT}">${escXml(utilLabel)}</text>`
        );
      }
    }
  }

  // -- Player markers --
  if (options.players) {
    for (const player of options.players) {
      const coord = resolveCallout(mapName, player.position);
      if (!coord) continue;

      const px = sx(coord.x);
      const py = sy(coord.y);
      const colors = TEAM_COLORS[player.team] || TEAM_COLORS.T;
      const roleLetter = ROLE_LETTER[player.role] || "?";
      const r = annotationSize(17);
      const role = roleLabel(player.role);
      const phaseMeta = phaseMetaFor(phaseItems, [player.phase, player.timing, player.task, player.label], "Opening");
      const phaseAttrText = phaseAttrs(phaseMeta);
      const playerLabel = labelText([phaseMeta ? `${phaseMeta.index + 1}. ${phaseMeta.name}` : player.phase, player.label || role, player.timing, player.task], 42);
      const playerTooltip = tooltip([
        `${player.team} ${role}`,
        phaseMeta ? `${phaseMeta.index + 1}. ${phaseMeta.name}` : player.phase,
        player.position,
        player.timing,
        player.task,
      ]);
      const playerAttrs = `data-tm-type="player" ${phaseAttrText} data-tm-team="${escXml(player.team)}" data-tm-role="${escXml(role)}" data-tm-tooltip="${escXml(playerTooltip)}" class="tm-player"`;

      // Shadow
      overlays.push(
        `<circle data-tm-type="player" ${phaseAttrText} class="tm-player" cx="${px + annotationSize(2)}" cy="${py + annotationSize(2)}" r="${r + annotationSize(2)}" fill="rgba(0,0,0,0.56)"/>`
      );

      // Main circle
      overlays.push(
        `<circle ${playerAttrs} cx="${px}" cy="${py}" r="${r}" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="${annotationSize(3)}"/>`
      );

      // Role letter
      overlays.push(
        `<text ${playerAttrs} x="${px}" y="${py + annotationSize(1)}" font-size="${annotationSize(15)}" font-weight="900" fill="white" ${SMALL_TEXT_HALO} text-anchor="middle" dominant-baseline="middle" font-family="${TACTICAL_FONT}">${roleLetter}</text>`
      );

      if (playerLabel) {
        overlays.push(
          `<text ${playerAttrs} x="${px}" y="${py + r + annotationSize(14)}" font-size="${annotationSize(9.5)}" font-weight="800" fill="white" ${TEXT_HALO} text-anchor="middle" font-family="${TACTICAL_FONT}">${escXml(playerLabel)}</text>`
        );
      }
    }
  }

  // -- Legend box (top-right) --
  const legendItems: string[] = [];

  // Determine which types of markers are used
  const hasCT = options.players?.some((p) => p.team === "CT");
  const hasT = options.players?.some((p) => p.team === "T");
  const usedUtilTypes = new Set(options.utility?.map((u) => u.type) || []);

  if (hasCT) {
    legendItems.push(
      `<circle cx="840" cy="___Y___" r="${annotationSize(6)}" fill="#4FC3F7" stroke="white" stroke-width="${annotationSize(1.5)}"/><text x="852" y="___Y___" font-size="${annotationSize(9)}" fill="white" dominant-baseline="middle" font-family="${TACTICAL_FONT}">CT Player</text>`
    );
  }
  if (hasT) {
    legendItems.push(
      `<circle cx="840" cy="___Y___" r="${annotationSize(6)}" fill="#EF5350" stroke="white" stroke-width="${annotationSize(1.5)}"/><text x="852" y="___Y___" font-size="${annotationSize(9)}" fill="white" dominant-baseline="middle" font-family="${TACTICAL_FONT}">T Player</text>`
    );
  }
  for (const ut of usedUtilTypes) {
    const s = UTILITY_STYLE[ut];
    if (!s) continue;
    legendItems.push(
      `<circle cx="840" cy="___Y___" r="${annotationSize(5)}" fill="${s.fill}" stroke="white" stroke-width="${annotationSize(1)}"/><text x="852" y="___Y___" font-size="${annotationSize(9)}" fill="white" dominant-baseline="middle" font-family="${TACTICAL_FONT}">${s.name}</text>`
    );
  }

  if (legendItems.length > 0) {
    const boxX = 825;
    const boxY = 10;
    const lineH = annotationSize(20);
    const boxH = legendItems.length * lineH + annotationSize(12);
    const boxW = 185;

    let legendSvg = `<rect data-tm-type="system" x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="${annotationSize(4)}" fill="rgba(0,0,0,0.65)" stroke="rgba(255,255,255,0.2)" stroke-width="${annotationSize(1)}"/>`;

    for (let i = 0; i < legendItems.length; i++) {
      const yPos = boxY + annotationSize(16) + i * lineH;
      legendSvg += legendItems[i].replace(/___Y___/g, String(yPos));
    }

    overlays.push(legendSvg);
  }

  // -- Phase / timing notes (bottom-left) --
  const phaseNotes = (options.phases || [])
    .map((phase) => ({ ...phase, name: canonicalPhaseName(phase.name) || phase.name }))
    .sort((a, b) => phaseOrderIndex(a) - phaseOrderIndex(b))
    .slice(0, PHASE_CAP);
  if (phaseNotes.length > 0) {
    const boxX = 10;
    const lineH = annotationSize(22);
    const boxW = 455;
    const boxH = annotationSize(42) + phaseNotes.length * lineH;
    const boxY = MAP_SIZE - boxH - 10;
    let phaseSvg = `<rect data-tm-type="timing" class="tm-timing" x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="${annotationSize(6)}" fill="rgba(0,0,0,0.74)" stroke="rgba(255,255,255,0.22)" stroke-width="${annotationSize(1)}"/>`;
    phaseSvg += `<text data-tm-type="timing" class="tm-timing" x="${boxX + annotationSize(12)}" y="${boxY + annotationSize(24)}" font-size="${annotationSize(11)}" font-weight="900" fill="#ffb347" ${SMALL_TEXT_HALO} font-family="${TACTICAL_FONT}">TACTICAL TIMELINE</text>`;

    phaseNotes.forEach((phase, i) => {
      const meta = phaseItems[i] || { index: i, name: phase.name, type: phaseTypeFromText(phase.name) };
      const attrs = phaseAttrs(meta);
      const y = boxY + annotationSize(48) + i * lineH;
      const prefix = compact([`${meta.index + 1}. ${meta.name}`, phase.timing]).join(" — ");
      const text = labelText([prefix, phase.description], 66);
      const tip = tooltip([phase.timing, phase.name, phase.description, phase.callouts?.join(" → ")]);
      phaseSvg += `<text data-tm-type="timing" ${attrs} data-tm-tooltip="${escXml(tip)}" class="tm-timing" x="${boxX + annotationSize(12)}" y="${y}" font-size="${annotationSize(9.5)}" font-weight="700" fill="rgba(255,255,255,0.88)" ${SMALL_TEXT_HALO} font-family="${TACTICAL_FONT}">${escXml(text)}</text>`;
    });

    overlays.push(phaseSvg);
  }

  // -- Title text --
  if (options.title) {
    overlays.push(
      `<rect data-tm-type="system" x="0" y="0" width="${MAP_SIZE}" height="${annotationSize(36)}" fill="rgba(0,0,0,0.55)"/>`
    );
    overlays.push(
      `<text data-tm-type="system" x="${annotationSize(12)}" y="${annotationSize(24)}" font-size="${annotationSize(18)}" font-weight="900" fill="white" ${SMALL_TEXT_HALO} font-family="${TACTICAL_FONT}">${escXml(options.title)}</text>`
    );
    if (options.side) {
      const sideColor = options.side === "CT" ? "#4FC3F7" : "#EF5350";
      overlays.push(
        `<text data-tm-type="system" x="${MAP_SIZE - annotationSize(12)}" y="${annotationSize(24)}" font-size="${annotationSize(14)}" font-weight="800" fill="${sideColor}" ${SMALL_TEXT_HALO} text-anchor="end" font-family="${TACTICAL_FONT}">${escXml(options.side)} Side</text>`
      );
    }
  }

  // -- Compose final SVG --
  // The viewBox is expanded by MAP_PAD on all sides so scaled annotations
  // (callouts, arrows, legend) are never clipped at the edges.
  const finalSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-MAP_PAD} ${-MAP_PAD} ${VIEW_SIZE} ${VIEW_SIZE}" width="${VIEW_SIZE}" height="${VIEW_SIZE}" role="img">
  <title>Tactical Map: ${escXml(options.title || mapName)}</title>
  <g transform="translate(${MAP_PAD}, ${MAP_PAD})">
  ${innerContent}
  ${overlays.join("\n")}
  </g>
</svg>`;

  return finalSvg;
}

// ---------------------------------------------------------------------------
// 4. testGenerateMirageAExecute
// ---------------------------------------------------------------------------

export function testGenerateMirageAExecute(): string {
  const options: TacticalMapOptions = {
    mapName: "mirage",
    side: "T",
    title: "Mirage A Execute",
    players: [
      { position: "T Spawn", role: "igl", team: "T", phase: "Opening" },
      { position: "Top Mid", role: "awp", team: "T", phase: "Map control" },
      { position: "Palace", role: "entry", team: "T", phase: "Execute" },
      { position: "Apps Ramp", role: "lurk", team: "T", phase: "Map control" },
      { position: "Catwalk", role: "support", team: "T", phase: "Execute" },
    ],
    utility: [
      { type: "smoke", from: "T Roof", to: "CT", label: "CT Smoke", phase: "Execute" },
      { type: "smoke", from: "T Roof", to: "Jungle", label: "Jungle Smoke", phase: "Execute" },
      {
        type: "flash",
        from: "Top Mid",
        to: "A Site",
        label: "Pop Flash",
        phase: "Execute",
      },
    ],
    arrows: [
      { from: "T Spawn", to: "Top Mid", type: "push", color: "#EF5350", phase: "Opening" },
      { from: "Top Mid", to: "Catwalk", type: "push", color: "#EF5350", phase: "Map control" },
      { from: "Palace", to: "A Site", type: "push", color: "#EF5350", phase: "Execute" },
      { from: "T Roof", to: "CT", type: "throw", color: "#9E9E9E", phase: "Execute" },
      { from: "T Roof", to: "Jungle", type: "throw", color: "#9E9E9E", phase: "Execute" },
      { from: "A Site", to: "Ramp", type: "push", color: "#EF5350", phase: "Post-plant" },
    ],
    phases: [
      { name: "Opening", timing: "0:00-0:15", description: "Leave spawn and take safe spacing." },
      { name: "Map control", timing: "0:15-0:40", description: "Pressure mid and connector lanes." },
      { name: "Execute", timing: "0:40-0:58", description: "Layer smokes and entries into A." },
      { name: "Post-plant", timing: "post-plant", description: "Hold ramp and palace crossfires." },
    ],
    showZones: false,
  };

  const svg = renderTacticalMap(options);

  // Write to public/generated-maps/
  const outDir = path.join(process.cwd(), "public", "generated-maps");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const outPath = path.join(outDir, "mirage-a-execute.svg");
  fs.writeFileSync(outPath, svg, "utf-8");

  return outPath;
}

// ---------------------------------------------------------------------------
// CLI runner (for testing outside Next.js)
// ---------------------------------------------------------------------------

// When run directly with ts-node / tsx
const isMain =
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module;

if (isMain) {
  const result = testGenerateMirageAExecute();
  console.log(`Generated: ${result}`);
}
