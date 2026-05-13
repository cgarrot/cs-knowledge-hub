import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlayerMarker {
  position: string; // callout name
  role: "entry" | "support" | "awp" | "igl" | "lurk";
  team: "CT" | "T";
}

export interface UtilityMarker {
  type: "smoke" | "flash" | "molotov" | "he";
  from: string; // callout name
  to: string; // callout name
  label?: string;
}

export interface Arrow {
  from: string; // callout name
  to: string; // callout name
  type: "push" | "throw";
  color?: string;
}

export interface TacticalMapOptions {
  mapName: string;
  side?: "CT" | "T";
  title?: string;
  players?: PlayerMarker[];
  utility?: UtilityMarker[];
  arrows?: Arrow[];
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
  { fill: string; letter: string; shape: "circle" | "star" }
> = {
  smoke: { fill: "#9E9E9E", letter: "S", shape: "circle" },
  flash: { fill: "#FFD600", letter: "F", shape: "star" },
  molotov: { fill: "#FF9800", letter: "M", shape: "circle" },
  he: { fill: "#F44336", letter: "H", shape: "circle" },
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

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  // Use env var for base SVG path, fallback to relative path for dev
  const baseSvgDir = process.env.CS_MAP_SVG_DIR ||
    path.join(process.cwd(), "..", "..", "zob", "cs-zob-v1", "map");
  const baseSvgPath = path.join(baseSvgDir, `${mapName}.svg`);

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

  // Strip closing </svg> from base to inject overlays
  const svgBody = baseSvg.replace(/<\/svg>\s*$/, "");

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
    `<rect x="0" y="0" width="1024" height="1024" fill="black" opacity="0.15"/>`
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

      overlays.push(
        `<polygon points="${polyPoints}" fill="${fillColor}" stroke="rgba(255,255,255,0.3)" stroke-width="1"/>`
      );

      // Zone label at centroid
      const cx = sx(zone.centroid.x);
      const cy = sy(zone.centroid.y);
      overlays.push(
        `<text x="${cx}" y="${cy}" font-size="9" fill="rgba(255,255,255,0.6)" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif">${escXml(zone.name)}</text>`
      );
    }
  }

  // -- Callout labels --
  if (options.showCallouts) {
    for (const c of data.callouts) {
      const cx = sx(c.x);
      const cy = sy(c.y);
      overlays.push(
        `<text x="${cx}" y="${cy + 20}" font-size="8" fill="rgba(255,255,255,0.5)" text-anchor="middle" font-family="sans-serif">${escXml(c.name)}</text>`
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
      const dashArray = isThrow ? "stroke-dasharray=\"8,4\"" : "";
      const markerEnd = isThrow ? 'marker-end="url(#arrowThrow)"' : 'marker-end="url(#arrowPush)"';

      overlays.push(
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${strokeColor}" stroke-width="2.5" ${dashArray} ${markerEnd} opacity="0.85"/>`
      );
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
      const r = 10;

      // Throw trajectory line
      if (fromCoord) {
        const fx = sx(fromCoord.x);
        const fy = sy(fromCoord.y);
        overlays.push(
          `<line x1="${fx}" y1="${fy}" x2="${tx}" y2="${ty}" stroke="${style.fill}" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.6"/>`
        );
      }

      // Shape
      if (style.shape === "star") {
        const pts = starPoints(tx, ty, r, r * 0.45, 5);
        overlays.push(
          `<polygon points="${pts}" fill="${style.fill}" stroke="white" stroke-width="1" opacity="0.9"/>`
        );
      } else {
        overlays.push(
          `<circle cx="${tx}" cy="${ty}" r="${r}" fill="${style.fill}" stroke="white" stroke-width="1" opacity="0.9"/>`
        );
      }

      // Letter
      overlays.push(
        `<text x="${tx}" y="${ty + 1}" font-size="10" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif">${style.letter}</text>`
      );

      // Optional label
      if (util.label) {
        overlays.push(
          `<text x="${tx}" y="${ty - 14}" font-size="7" fill="white" text-anchor="middle" font-family="sans-serif">${escXml(util.label)}</text>`
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
      const r = 14;

      // Shadow
      overlays.push(
        `<circle cx="${px + 1}" cy="${py + 1}" r="${r}" fill="rgba(0,0,0,0.4)"/>`
      );

      // Main circle
      overlays.push(
        `<circle cx="${px}" cy="${py}" r="${r}" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="2"/>`
      );

      // Role letter
      overlays.push(
        `<text x="${px}" y="${py + 1}" font-size="13" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif">${roleLetter}</text>`
      );
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
      `<circle cx="840" cy="___Y___" r="6" fill="#4FC3F7" stroke="white" stroke-width="1.5"/><text x="852" y="___Y___" font-size="9" fill="white" dominant-baseline="middle" font-family="sans-serif">CT Player</text>`
    );
  }
  if (hasT) {
    legendItems.push(
      `<circle cx="840" cy="___Y___" r="6" fill="#EF5350" stroke="white" stroke-width="1.5"/><text x="852" y="___Y___" font-size="9" fill="white" dominant-baseline="middle" font-family="sans-serif">T Player</text>`
    );
  }
  for (const ut of usedUtilTypes) {
    const s = UTILITY_STYLE[ut];
    if (!s) continue;
    legendItems.push(
      `<circle cx="840" cy="___Y___" r="5" fill="${s.fill}" stroke="white" stroke-width="1"/><text x="852" y="___Y___" font-size="9" fill="white" dominant-baseline="middle" font-family="sans-serif">${ut.charAt(0).toUpperCase() + ut.slice(1)}</text>`
    );
  }

  if (legendItems.length > 0) {
    const boxX = 825;
    const boxY = 10;
    const lineH = 20;
    const boxH = legendItems.length * lineH + 12;
    const boxW = 185;

    let legendSvg = `<rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="4" fill="rgba(0,0,0,0.65)" stroke="rgba(255,255,255,0.2)" stroke-width="1"/>`;

    for (let i = 0; i < legendItems.length; i++) {
      const yPos = boxY + 16 + i * lineH;
      legendSvg += legendItems[i].replace(/___Y___/g, String(yPos));
    }

    overlays.push(legendSvg);
  }

  // -- Title text --
  if (options.title) {
    overlays.push(
      `<rect x="0" y="0" width="1024" height="36" fill="rgba(0,0,0,0.55)"/>`
    );
    overlays.push(
      `<text x="12" y="24" font-size="18" font-weight="bold" fill="white" font-family="sans-serif">${escXml(options.title)}</text>`
    );
    if (options.side) {
      const sideColor = options.side === "CT" ? "#4FC3F7" : "#EF5350";
      overlays.push(
        `<text x="1012" y="24" font-size="14" fill="${sideColor}" text-anchor="end" font-family="sans-serif">${options.side} Side</text>`
      );
    }
  }

  // -- Compose final SVG --
  // Insert overlays before closing </svg>
  const finalSvg = svgBody + overlays.join("\n") + "\n</svg>";

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
