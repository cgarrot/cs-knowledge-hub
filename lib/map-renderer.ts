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
}

export interface UtilityMarker {
  type: "smoke" | "flash" | "molotov" | "he";
  from: string; // callout name
  to: string; // callout name
  label?: string;
  timing?: string;
  purpose?: string;
  player?: string;
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

/** Annotation scale relative to the base radar image. */
const ANNOTATION_SCALE = 1.25;

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

  // -- Defs for arrowhead markers --
  overlays.push(`
  <defs>
    <marker id="arrowPush" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" fill="#FFFFFF"/>
    </marker>
    <marker id="arrowThrow" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" fill="#FFD600"/>
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
        site: "rgba(255,200,0,0.15)",
        spawn: "rgba(100,100,255,0.12)",
        connector: "rgba(100,255,100,0.10)",
        area: "rgba(200,200,200,0.08)",
      };
      const fillColor = zoneColors[zone.type] || "rgba(200,200,200,0.08)";
      const zoneAttrs = `data-tm-type="zone" data-tm-callout="${escXml(zone.name)}" data-tm-tooltip="${escXml(zone.name)}" class="tm-zone"`;

      overlays.push(
        `<polygon ${zoneAttrs} points="${polyPoints}" fill="${fillColor}" stroke="rgba(255,255,255,0.3)" stroke-width="${annotationSize(1)}"/>`
      );

      // Zone label at centroid
      const cx = sx(zone.centroid.x);
      const cy = sy(zone.centroid.y);
      overlays.push(
        `<text data-tm-type="zone" class="tm-zone" x="${cx}" y="${cy}" font-size="${annotationSize(9)}" fill="rgba(255,255,255,0.6)" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif">${escXml(zone.name)}</text>`
      );
    }
  }

  // -- Callout labels --
  if (options.showCallouts) {
    for (const c of data.callouts) {
      const cx = sx(c.x);
      const cy = sy(c.y);
      overlays.push(
        `<text data-tm-type="zone" data-tm-tooltip="${escXml(c.name)}" class="tm-zone" x="${cx}" y="${cy + annotationSize(20)}" font-size="${annotationSize(8)}" fill="rgba(255,255,255,0.5)" text-anchor="middle" font-family="sans-serif">${escXml(c.name)}</text>`
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
      const dashArray = isThrow ? `stroke-dasharray="${dashPattern(8, 4)}"` : "";
      const markerEnd = isThrow ? 'marker-end="url(#arrowThrow)"' : 'marker-end="url(#arrowPush)"';
      const arrowLabel = labelText([arrow.phase, arrow.timing, arrow.label], 30);
      const arrowTooltip = tooltip([
        isThrow ? "Throw route" : "Movement route",
        arrow.phase,
        arrow.timing,
        arrow.label,
        `${arrow.from} → ${arrow.to}`,
      ]);

      overlays.push(
        `<line data-tm-type="arrow" data-tm-tooltip="${escXml(arrowTooltip)}" class="tm-arrow" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${strokeColor}" stroke-width="${annotationSize(2.5)}" ${dashArray} ${markerEnd} opacity="0.85"/>`
      );

      if (arrowLabel) {
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        overlays.push(
          `<text data-tm-type="arrow" data-tm-tooltip="${escXml(arrowTooltip)}" class="tm-arrow" x="${mx}" y="${my - annotationSize(6)}" font-size="${annotationSize(8)}" fill="${strokeColor}" text-anchor="middle" font-family="sans-serif">${escXml(arrowLabel)}</text>`
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
      const r = annotationSize(10);
      const utilName = style.name;
      const utilLabel = labelText([util.timing, util.label || util.purpose], 30);
      const utilTooltip = tooltip([
        utilName,
        util.timing,
        util.player,
        util.purpose || util.label,
        `${util.from} → ${util.to}`,
      ]);
      const utilAttrs = `data-tm-type="utility" data-tm-utility-type="${escXml(utilName)}" data-tm-tooltip="${escXml(utilTooltip)}" class="tm-utility"`;

      // Throw trajectory line
      if (fromCoord) {
        const fx = sx(fromCoord.x);
        const fy = sy(fromCoord.y);
        overlays.push(
          `<line ${utilAttrs} x1="${fx}" y1="${fy}" x2="${tx}" y2="${ty}" stroke="${style.fill}" stroke-width="${annotationSize(1.5)}" stroke-dasharray="${dashPattern(4, 3)}" opacity="0.6"/>`
        );
      }

      // Shape
      if (style.shape === "star") {
        const pts = starPoints(tx, ty, r, r * 0.45, 5);
        overlays.push(
          `<polygon ${utilAttrs} points="${pts}" fill="${style.fill}" stroke="white" stroke-width="${annotationSize(1)}" opacity="0.9"/>`
        );
      } else if (style.shape === "diamond") {
        const pts = regularPolygonPoints(tx, ty, r, 4, -Math.PI / 2);
        overlays.push(
          `<polygon ${utilAttrs} points="${pts}" fill="${style.fill}" stroke="white" stroke-width="${annotationSize(1)}" opacity="0.9"/>`
        );
      } else if (style.shape === "hex") {
        const pts = regularPolygonPoints(tx, ty, r, 6);
        overlays.push(
          `<polygon ${utilAttrs} points="${pts}" fill="${style.fill}" stroke="white" stroke-width="${annotationSize(1)}" opacity="0.9"/>`
        );
      } else {
        overlays.push(
          `<circle ${utilAttrs} cx="${tx}" cy="${ty}" r="${r}" fill="${style.fill}" stroke="white" stroke-width="${annotationSize(1)}" opacity="0.9"/>`
        );
      }

      // Letter
      overlays.push(
        `<text ${utilAttrs} x="${tx}" y="${ty + annotationSize(1)}" font-size="${annotationSize(10)}" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif">${style.letter}</text>`
      );

      // Optional label
      if (utilLabel) {
        overlays.push(
          `<text ${utilAttrs} x="${tx}" y="${ty - annotationSize(14)}" font-size="${annotationSize(7)}" fill="white" text-anchor="middle" font-family="sans-serif">${escXml(utilLabel)}</text>`
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
      const r = annotationSize(14);
      const role = roleLabel(player.role);
      const playerLabel = labelText([player.label || role, player.timing, player.task], 32);
      const playerTooltip = tooltip([
        `${player.team} ${role}`,
        player.position,
        player.timing,
        player.task,
      ]);
      const playerAttrs = `data-tm-type="player" data-tm-team="${escXml(player.team)}" data-tm-role="${escXml(role)}" data-tm-tooltip="${escXml(playerTooltip)}" class="tm-player"`;

      // Shadow
      overlays.push(
        `<circle data-tm-type="player" class="tm-player" cx="${px + annotationSize(1)}" cy="${py + annotationSize(1)}" r="${r}" fill="rgba(0,0,0,0.4)"/>`
      );

      // Main circle
      overlays.push(
        `<circle ${playerAttrs} cx="${px}" cy="${py}" r="${r}" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="${annotationSize(2)}"/>`
      );

      // Role letter
      overlays.push(
        `<text ${playerAttrs} x="${px}" y="${py + annotationSize(1)}" font-size="${annotationSize(13)}" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif">${roleLetter}</text>`
      );

      if (playerLabel) {
        overlays.push(
          `<text ${playerAttrs} x="${px}" y="${py + r + annotationSize(10)}" font-size="${annotationSize(7.5)}" fill="white" text-anchor="middle" font-family="sans-serif">${escXml(playerLabel)}</text>`
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
      `<circle cx="840" cy="___Y___" r="${annotationSize(6)}" fill="#4FC3F7" stroke="white" stroke-width="${annotationSize(1.5)}"/><text x="852" y="___Y___" font-size="${annotationSize(9)}" fill="white" dominant-baseline="middle" font-family="sans-serif">CT Player</text>`
    );
  }
  if (hasT) {
    legendItems.push(
      `<circle cx="840" cy="___Y___" r="${annotationSize(6)}" fill="#EF5350" stroke="white" stroke-width="${annotationSize(1.5)}"/><text x="852" y="___Y___" font-size="${annotationSize(9)}" fill="white" dominant-baseline="middle" font-family="sans-serif">T Player</text>`
    );
  }
  for (const ut of usedUtilTypes) {
    const s = UTILITY_STYLE[ut];
    if (!s) continue;
    legendItems.push(
      `<circle cx="840" cy="___Y___" r="${annotationSize(5)}" fill="${s.fill}" stroke="white" stroke-width="${annotationSize(1)}"/><text x="852" y="___Y___" font-size="${annotationSize(9)}" fill="white" dominant-baseline="middle" font-family="sans-serif">${s.name}</text>`
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
  const phaseItems = options.phases?.slice(0, 6) || [];
  if (phaseItems.length > 0) {
    const boxX = 10;
    const lineH = annotationSize(17);
    const boxW = 360;
    const boxH = annotationSize(34) + phaseItems.length * lineH;
    const boxY = MAP_SIZE - boxH - 10;
    let phaseSvg = `<rect data-tm-type="timing" class="tm-timing" x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="${annotationSize(4)}" fill="rgba(0,0,0,0.68)" stroke="rgba(255,255,255,0.2)" stroke-width="${annotationSize(1)}"/>`;
    phaseSvg += `<text data-tm-type="timing" class="tm-timing" x="${boxX + annotationSize(10)}" y="${boxY + annotationSize(20)}" font-size="${annotationSize(10)}" font-weight="bold" fill="white" font-family="sans-serif">Timing / phases</text>`;

    phaseItems.forEach((phase, i) => {
      const y = boxY + annotationSize(38) + i * lineH;
      const prefix = compact([phase.timing, phase.name]).join(" — ");
      const text = labelText([prefix, phase.description], 58);
      const tip = tooltip([phase.timing, phase.name, phase.description, phase.callouts?.join(" → ")]);
      phaseSvg += `<text data-tm-type="timing" data-tm-tooltip="${escXml(tip)}" class="tm-timing" x="${boxX + annotationSize(10)}" y="${y}" font-size="${annotationSize(8.5)}" fill="rgba(255,255,255,0.82)" font-family="sans-serif">${escXml(text)}</text>`;
    });

    overlays.push(phaseSvg);
  }

  // -- Title text --
  if (options.title) {
    overlays.push(
      `<rect data-tm-type="system" x="0" y="0" width="${MAP_SIZE}" height="${annotationSize(36)}" fill="rgba(0,0,0,0.55)"/>`
    );
    overlays.push(
      `<text data-tm-type="system" x="${annotationSize(12)}" y="${annotationSize(24)}" font-size="${annotationSize(18)}" font-weight="bold" fill="white" font-family="sans-serif">${escXml(options.title)}</text>`
    );
    if (options.side) {
      const sideColor = options.side === "CT" ? "#4FC3F7" : "#EF5350";
      overlays.push(
        `<text data-tm-type="system" x="${MAP_SIZE - annotationSize(12)}" y="${annotationSize(24)}" font-size="${annotationSize(14)}" fill="${sideColor}" text-anchor="end" font-family="sans-serif">${escXml(options.side)} Side</text>`
      );
    }
  }

  // -- Compose final SVG --
  // Keep the base radar and annotation coordinates in the same 1024x1024
  // viewBox. Only marker/font/stroke dimensions are scaled by ANNOTATION_SCALE,
  // so the callouts are 1.25x more readable without zooming the whole map.
  const finalSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MAP_SIZE} ${MAP_SIZE}" width="${MAP_SIZE}" height="${MAP_SIZE}" role="img">
  <title>Tactical Map: ${escXml(options.title || mapName)}</title>
  ${innerContent}
  ${overlays.join("\n")}
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
      { position: "T Spawn", role: "igl", team: "T" },
      { position: "Top Mid", role: "awp", team: "T" },
      { position: "Palace", role: "entry", team: "T" },
      { position: "Apps Ramp", role: "lurk", team: "T" },
      { position: "Catwalk", role: "support", team: "T" },
    ],
    utility: [
      { type: "smoke", from: "T Roof", to: "CT", label: "CT Smoke" },
      { type: "smoke", from: "T Roof", to: "Jungle", label: "Jungle Smoke" },
      {
        type: "flash",
        from: "Top Mid",
        to: "A Site",
        label: "Pop Flash",
      },
    ],
    arrows: [
      { from: "Palace", to: "A Site", type: "push", color: "#EF5350" },
      { from: "T Roof", to: "CT", type: "throw", color: "#9E9E9E" },
      { from: "T Roof", to: "Jungle", type: "throw", color: "#9E9E9E" },
      { from: "Top Mid", to: "A Site", type: "throw", color: "#FFD600" },
      { from: "Catwalk", to: "Stairs", type: "push", color: "#EF5350" },
    ],
    showZones: true,
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
