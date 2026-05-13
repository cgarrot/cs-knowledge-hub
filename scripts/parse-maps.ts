/**
 * Phase 1: Parse and index all CS2 map data into structured JSON files.
 *
 * Reads raw map data from ~/zob/cs-zob-v1/ and outputs structured JSON
 * to ~/cs-knowledge/app/data/maps/.
 *
 * Data sources:
 *   - overlay.svg: polygon zones with callout names (coords in 1000x1000 webp space)
 *   - callouts.json: callout metadata (title, description) linked by polygon_id
 *   - meta.json: map metadata
 *   - base map SVGs: 1024x1024 viewBox radar maps
 *
 * Coordinate system:
 *   The overlay SVG coordinates are in the same space as the 1000x1000 webp images.
 *   The base map SVGs use 1024x1024. To convert overlay -> base: multiply by 1.024.
 *   The stored coordinates are in overlay space (1000-based) since that's the native
 *   resolution of the callout data. The frontend can scale by 1.024 when rendering
 *   on the 1024x1024 base map SVG, with an additional 1.25x factor as needed.
 *
 * Usage: cd ~/cs-knowledge/app && npx tsx scripts/parse-maps.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Configuration ───────────────────────────────────────────────────────────

const RAW_DATA_ROOT = path.join(
  process.env.HOME || "/home/ubuntu",
  "zob/cs-zob-v1"
);
const OUTPUT_DIR = path.join(
  process.env.HOME || "/home/ubuntu",
  "cs-knowledge/app/data/maps"
);

const MAP_NAMES = [
  "dust2",
  "mirage",
  "inferno",
  "ancient",
  "anubis",
  "nuke",
  "overpass",
  "vertigo",
] as const;

// Scale factor: overlay coords (1000 space) → base SVG (1024 space)
// 1024 / 1000 = 1.024. Additional 1.25x can be applied by the frontend.
const COORD_SCALE = 1024 / 1000; // 1.024

// ─── Types ───────────────────────────────────────────────────────────────────

interface RawCallout {
  polygon_id: string;
  title: string;
  description: string;
}

interface RawMeta {
  url: string;
  slug: string;
  map_key: string;
  title: string;
  callout_count: number;
  has_overlay_svg: boolean;
}

interface Point {
  x: number;
  y: number;
}

interface Zone {
  name: string;
  polygon: number[][]; // [[x1,y1],[x2,y2],...]
  centroid: Point;
  type: "site" | "spawn" | "connector" | "area";
  description?: string;
}

interface Callout {
  name: string;
  x: number;
  y: number;
  zone: string;
  description?: string;
}

interface MapSites {
  A: Point;
  B: Point;
}

interface MapSpawns {
  CT: Point;
  T: Point;
}

interface MapData {
  name: string;
  displayName: string;
  viewBox: number[];
  sites: MapSites;
  spawns: MapSpawns;
  callouts: Callout[];
  zones: Zone[];
  meta: {
    source: string;
    calloutCount: number;
  };
}

interface MapIndexEntry {
  name: string;
  displayName: string;
  calloutCount: number;
  hasOverlay: boolean;
}

// ─── SVG Parsing Helpers ─────────────────────────────────────────────────────

/**
 * Parse polygon points string into array of [x, y] pairs.
 * "671.1,244.5 736.1,244.5" => [[671.1, 244.5], [736.1, 244.5]]
 */
function parsePolygonPoints(pointsStr: string): number[][] {
  return pointsStr
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [x, y] = pair.split(",").map(Number);
      return [x, y];
    });
}

/**
 * Compute centroid of a polygon from its vertices.
 */
function computeCentroid(vertices: number[][]): Point {
  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of vertices) {
    sumX += x;
    sumY += y;
  }
  return {
    x: Math.round(sumX / vertices.length),
    y: Math.round(sumY / vertices.length),
  };
}

interface ParsedZone {
  polygonId: string;
  name: string;
  polygon: number[][];
  textPos: Point; // position of the label text
  centroid: Point;
}

/**
 * Parse the overlay SVG to extract all zones.
 * Each zone is a <g data-polygon-id="..."> containing a <polygon> and <text> with <tspan>.
 */
function parseOverlaySvg(svgContent: string): ParsedZone[] {
  const zones: ParsedZone[] = [];

  // Match each <g data-polygon-id="..."> ... </g> block
  const groupRegex =
    /<g\s+data-polygon-id="([^"]+)">([\s\S]*?)<\/g>/g;
  let groupMatch: RegExpExecArray | null;

  while ((groupMatch = groupRegex.exec(svgContent)) !== null) {
    const polygonId = groupMatch[1];
    const groupContent = groupMatch[2];

    // Extract polygon points
    const polyMatch = groupContent.match(
      /<polygon\s+points="([^"]+)"/
    );
    if (!polyMatch) continue;
    const polygon = parsePolygonPoints(polyMatch[1]);
    const centroid = computeCentroid(polygon);

    // Extract text position and label
    const textMatch = groupContent.match(
      /<text\s+x="([^"]+)"\s+y="([^"]+)"[^>]*>([\s\S]*?)<\/text>/
    );
    if (!textMatch) continue;

    const textPos: Point = {
      x: Math.round(parseFloat(textMatch[1])),
      y: Math.round(parseFloat(textMatch[2])),
    };

    // Extract tspan text content (may be multiline: "CT\n" + "Spawn")
    const tspanTexts: string[] = [];
    const tspanRegex = /<tspan[^>]*>([^<]*)<\/tspan>/g;
    let tspanMatch: RegExpExecArray | null;
    while ((tspanMatch = tspanRegex.exec(textMatch[3])) !== null) {
      if (tspanMatch[1].trim()) {
        tspanTexts.push(tspanMatch[1].trim());
      }
    }
    const name = tspanTexts.join(" ");

    if (!name) continue;

    zones.push({
      polygonId,
      name,
      polygon,
      textPos,
      centroid,
    });
  }

  return zones;
}

// ─── Zone Classification ─────────────────────────────────────────────────────

function classifyZone(name: string): Zone["type"] {
  const lower = name.toLowerCase();

  if (lower.includes("site") || lower.includes("bombsite")) return "site";
  if (lower.includes("spawn")) return "spawn";
  if (
    lower.includes("connector") ||
    lower.includes("mid") ||
    lower.includes("cat") ||
    lower.includes("tunnels") ||
    lower.includes("ramp") ||
    lower.includes("short") ||
    lower.includes("long") ||
    lower.includes("alley")
  )
    return "connector";
  return "area";
}

/**
 * Find a zone by flexible name matching.
 */
function findZone(
  zones: ParsedZone[],
  ...patterns: string[]
): ParsedZone | undefined {
  for (const pattern of patterns) {
    const found = zones.find(
      (z) => z.name.toLowerCase() === pattern.toLowerCase()
    );
    if (found) return found;
  }
  // Partial match fallback
  for (const pattern of patterns) {
    const found = zones.find((z) =>
      z.name.toLowerCase().includes(pattern.toLowerCase())
    );
    if (found) return found;
  }
  return undefined;
}

/**
 * Extract key positions (sites and spawns) from zones.
 * Uses text position for more accurate labeling, centroid as fallback.
 */
function extractKeyPositions(zones: ParsedZone[]): {
  sites: Partial<MapSites>;
  spawns: Partial<MapSpawns>;
} {
  const result: { sites: Partial<MapSites>; spawns: Partial<MapSpawns> } = {
    sites: {},
    spawns: {},
  };

  // A Site
  const aSite = findZone(zones, "A Site", "A Bombsite", "Bomb Site A");
  if (aSite) {
    result.sites.A = aSite.centroid;
  }

  // B Site
  const bSite = findZone(zones, "B Site", "B Bombsite", "Bomb Site B");
  if (bSite) {
    result.sites.B = bSite.centroid;
  }

  // CT Spawn
  const ctSpawn = findZone(zones, "CT Spawn", "Counter-Terrorist Spawn", "CT Spawn\n");
  if (ctSpawn) {
    result.spawns.CT = ctSpawn.centroid;
  }

  // T Spawn
  const tSpawn = findZone(zones, "T Spawn", "Terrorist Spawn", "T Spawn\n");
  if (tSpawn) {
    result.spawns.T = tSpawn.centroid;
  }

  return result;
}

// ─── Build Callout List ──────────────────────────────────────────────────────

function buildCallouts(
  zones: ParsedZone[],
  rawCallouts: RawCallout[]
): Callout[] {
  // Build a lookup from polygon_id to raw callout
  const calloutMap = new Map<string, RawCallout>();
  for (const c of rawCallouts) {
    calloutMap.set(c.polygon_id, c);
  }

  return zones.map((zone) => {
    const raw = calloutMap.get(zone.polygonId);
    return {
      name: zone.name,
      x: zone.textPos.x,
      y: zone.textPos.y,
      zone: zone.name,
      description: raw?.description,
    };
  });
}

// ─── Main Processing ─────────────────────────────────────────────────────────

function processMap(mapName: string): MapData | null {
  console.log(`\n Processing ${mapName}...`);

  const metaPath = path.join(RAW_DATA_ROOT, "skinclub", mapName, "meta.json");
  const calloutsPath = path.join(
    RAW_DATA_ROOT,
    "skinclub",
    mapName,
    "callouts.json"
  );
  const overlayPath = path.join(
    RAW_DATA_ROOT,
    "skinclub",
    mapName,
    "overlay.svg"
  );

  // Read metadata
  if (!fs.existsSync(metaPath)) {
    console.warn(`  ⚠ No meta.json for ${mapName}, skipping`);
    return null;
  }
  const meta: RawMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));

  // Read callouts
  const rawCallouts: RawCallout[] = fs.existsSync(calloutsPath)
    ? JSON.parse(fs.readFileSync(calloutsPath, "utf-8"))
    : [];

  // Read overlay SVG
  let zones: ParsedZone[] = [];
  if (fs.existsSync(overlayPath) && meta.has_overlay_svg) {
    const svgContent = fs.readFileSync(overlayPath, "utf-8");
    zones = parseOverlaySvg(svgContent);
    console.log(
      `  Found ${zones.length} zones in overlay SVG`
    );
  } else {
    console.warn(`  ⚠ No overlay SVG for ${mapName}`);
  }

  // Extract key positions
  const { sites, spawns } = extractKeyPositions(zones);

  if (!sites.A) console.warn(`  ⚠ Could not find A Site for ${mapName}`);
  if (!sites.B) console.warn(`  ⚠ Could not find B Site for ${mapName}`);
  if (!spawns.CT) console.warn(`  ⚠ Could not find CT Spawn for ${mapName}`);
  if (!spawns.T) console.warn(`  ⚠ Could not find T Spawn for ${mapName}`);

  // Build display name
  const displayName =
    mapName.charAt(0).toUpperCase() + mapName.slice(1);

  // Build zones array
  const zonesOutput: Zone[] = zones.map((z) => ({
    name: z.name,
    polygon: z.polygon.map(([x, y]) => [Math.round(x), Math.round(y)]),
    centroid: z.centroid,
    type: classifyZone(z.name),
  }));

  // Build callouts array
  const calloutsOutput = buildCallouts(zones, rawCallouts);

  const mapData: MapData = {
    name: mapName,
    displayName,
    viewBox: [0, 0, 1024, 1024],
    sites: sites as MapSites,
    spawns: spawns as MapSpawns,
    callouts: calloutsOutput,
    zones: zonesOutput,
    meta: {
      source: meta.url,
      calloutCount: rawCallouts.length,
    },
  };

  console.log(
    `  ✓ ${displayName}: ${calloutsOutput.length} callouts, ${zonesOutput.length} zones`
  );

  return mapData;
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

function main() {
  console.log("═══ CS2 Map Data Parser ═══");
  console.log(`Raw data: ${RAW_DATA_ROOT}`);
  console.log(`Output:   ${OUTPUT_DIR}`);

  // Ensure output directory exists
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const indexEntries: MapIndexEntry[] = [];
  let successCount = 0;
  let failCount = 0;

  for (const mapName of MAP_NAMES) {
    try {
      const mapData = processMap(mapName);
      if (!mapData) {
        failCount++;
        continue;
      }

      // Write individual map JSON
      const outputPath = path.join(OUTPUT_DIR, `${mapName}.json`);
      fs.writeFileSync(outputPath, JSON.stringify(mapData, null, 2));
      console.log(`  → Wrote ${outputPath}`);

      indexEntries.push({
        name: mapName,
        displayName: mapData.displayName,
        calloutCount: mapData.meta.calloutCount,
        hasOverlay: mapData.zones.length > 0,
      });

      successCount++;
    } catch (err) {
      console.error(`  ✗ Error processing ${mapName}:`, err);
      failCount++;
    }
  }

  // Write index.json
  const indexPath = path.join(OUTPUT_DIR, "index.json");
  fs.writeFileSync(
    indexPath,
    JSON.stringify(
      {
        maps: indexEntries,
        generatedAt: new Date().toISOString(),
        totalMaps: indexEntries.length,
        coordinateSystem: {
          description:
            "Coordinates are in overlay space (1000x1000, matching the webp images). Multiply by 1.024 (1024/1000) to convert to base SVG (1024x1024) space.",
          overlaySize: 1000,
          baseSvgSize: 1024,
          scaleFactor: 1.024,
        },
      },
      null,
      2
    )
  );
  console.log(`\n→ Wrote ${indexPath}`);

  // Summary
  console.log("\n═══ Summary ═══");
  console.log(
    `  ✓ ${successCount} maps processed successfully`
  );
  if (failCount > 0) {
    console.log(`  ✗ ${failCount} maps failed`);
  }

  // Print alignment verification
  console.log("\n═══ Alignment Verification ═══");
  for (const mapName of MAP_NAMES) {
    const mapPath = path.join(OUTPUT_DIR, `${mapName}.json`);
    if (!fs.existsSync(mapPath)) continue;
    const data: MapData = JSON.parse(fs.readFileSync(mapPath, "utf-8"));
    const parts: string[] = [];
    if (data.sites?.A)
      parts.push(`A=(${data.sites.A.x},${data.sites.A.y})`);
    if (data.sites?.B)
      parts.push(`B=(${data.sites.B.x},${data.sites.B.y})`);
    if (data.spawns?.CT)
      parts.push(`CT=(${data.spawns.CT.x},${data.spawns.CT.y})`);
    if (data.spawns?.T)
      parts.push(`T=(${data.spawns.T.x},${data.spawns.T.y})`);
    console.log(
      `  ${data.displayName.padEnd(10)} ${parts.join("  ")}`
    );
  }
}

main();
