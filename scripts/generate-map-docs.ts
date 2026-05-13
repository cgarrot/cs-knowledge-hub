#!/usr/bin/env npx tsx
/**
 * Generate markdown documentation from map callout data and skinclub articles.
 *
 * Reads map JSON data from data/maps/{name}.json and skinclub article HTML,
 * produces markdown files at ~/cs-knowledge/content/maps/ ready for RAG indexing.
 *
 * Usage: npx tsx scripts/generate-map-docs.ts
 */

import fs from "fs";
import path from "path";

// ─── Configuration ──────────────────────────────────────────────────────────

const APP_DIR = path.resolve(__dirname, "..");
const MAPS_DATA_DIR = path.join(APP_DIR, "data", "maps");
const SKINCLUB_DIR = "/home/ubuntu/zob/cs-zob-v1/skinclub";
const OUTPUT_DIR = "/home/ubuntu/cs-knowledge/content/maps";

// ─── Types ──────────────────────────────────────────────────────────────────

interface Position {
  x: number;
  y: number;
}

interface Callout {
  name: string;
  x: number;
  y: number;
  zone: string;
  description: string;
}

interface Zone {
  name: string;
  polygon: number[][];
  centroid: Position;
  type: "site" | "spawn" | "connector" | "area";
}

interface MapData {
  name: string;
  displayName: string;
  viewBox: number[];
  sites: Record<string, Position>;
  spawns: Record<string, Position>;
  callouts: Callout[];
  zones: Zone[];
  meta?: {
    source?: string;
    calloutCount?: number;
  };
}

interface MapIndexEntry {
  name: string;
  displayName: string;
  calloutCount: number;
  hasOverlay: boolean;
}

// ─── HTML Stripping ─────────────────────────────────────────────────────────

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&rsquo;": "'",
  "&lsquo;": "'",
  "&rdquo;": '"',
  "&ldquo;": '"',
  "&ndash;": "-",
  "&mdash;": "--",
  "&hellip;": "...",
  "&copy;": "(c)",
  "&reg;": "(R)",
};

function decodeEntities(text: string): string {
  let result = text;
  for (const [entity, replacement] of Object.entries(HTML_ENTITIES)) {
    result = result.split(entity).join(replacement);
  }
  // Numeric entities like &#8217;
  result = result.replace(/&#(\d+);/g, (_, code) =>
    String.fromCharCode(parseInt(code, 10))
  );
  return result;
}

function stripHtml(html: string): string {
  // Strategy: split into lines, remove noise lines, then process content lines
  let lines = html.split("\n");
  
  // Filter out lines that are purely noise (SVG, interactive map, tooltips, etc.)
  lines = lines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return true; // keep blank lines for structure
    // Remove lines that are purely SVG/interactive-map noise
    if (trimmed.includes("interactive-map")) return false;
    if (trimmed.includes("<svg")) return false;
    if (trimmed.includes("</svg>")) return false;
    if (trimmed.includes("<polygon")) return false;
    if (trimmed.includes("polygon_id")) return false;
    if (trimmed.includes("interactive-map-tooltip")) return false;
    if (trimmed.includes("data-polygon-id")) return false;
    if (trimmed.includes("data-eio=")) return false;
    // Remove purely structural div lines
    if (/^<div\s*\/?>$/.test(trimmed)) return false;
    if (trimmed === "</div>") return false;
    return true;
  });

  let text = lines.join("\n");

  // Extract article body only (between article__content div and end)
  const contentMatch = text.match(
    /<div class="article__content[^"]*">([\s\S]*)<\/div>\s*<\/div>\s*<\/article>/
  );
  if (contentMatch) {
    text = contentMatch[1];
  }

  // Remove remaining script/style/SVG blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, "");

  // Remove image tags (keep alt text)
  text = text.replace(/<img[^>]*alt="([^"]*)"[^>]*\/?>/gi, "$1");
  text = text.replace(/<img[^>]*\/?>/gi, "");

  // Convert headings to markdown
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, content) => {
    return `\n# ${stripInlineTags(content).trim()}\n`;
  });
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, content) => {
    return `\n## ${stripInlineTags(content).trim()}\n`;
  });
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, content) => {
    return `\n### ${stripInlineTags(content).trim()}\n`;
  });

  // Convert list items to markdown bullets
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, content) => {
    const cleaned = stripInlineTags(content).trim();
    return `\n- ${cleaned}`;
  });

  // Convert paragraphs to text blocks with spacing
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, content) => {
    const cleaned = stripInlineTags(content).trim();
    return cleaned ? `\n${cleaned}\n` : "";
  });

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode entities
  text = decodeEntities(text);

  // Clean up whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}

function stripInlineTags(html: string): string {
  let text = html;
  // Remove all inline HTML tags (b, span, a, strong, em, etc.)
  text = text.replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, "$1");
  text = text.replace(/<\/?(b|strong|em|i|span|u|small|sub|sup|br)\s*\/?>/gi, "");
  text = text.replace(/<br\s*\/?>/gi, " ");
  text = text.replace(/<[^>]+>/g, "");
  return decodeEntities(text);
}

// ─── Strategy Generation ────────────────────────────────────────────────────

function generateStrategies(mapData: MapData): string[] {
  const strategies: string[] = [];
  const { zones, sites, displayName } = mapData;

  const siteNames = Object.keys(sites); // e.g. ["A", "B"]
  const zoneNames = zones.map((z) => z.name.toLowerCase());
  const zoneTypes = new Map(zones.map((z) => [z.name.toLowerCase(), z.type]));

  // Detect connectors
  const connectors = zones
    .filter((z) => z.type === "connector")
    .map((z) => z.name);
  const spawnZones = zones
    .filter((z) => z.type === "spawn")
    .map((z) => z.name);
  const siteZones = zones.filter((z) => z.type === "site").map((z) => z.name);

  // CT Default strategies
  if (siteNames.length >= 2) {
    strategies.push(
      `CT Default: Split defense with 2 players on ${siteNames[0]} Site and 3 on ${siteNames[1]} Site, using ${connectors.length > 0 ? connectors.join(", ") + " for" : "mid for"} information gathering and rotations.`
    );
  }

  // T Default strategies
  if (spawnZones.length > 0) {
    strategies.push(
      `T Default: Spread out from ${spawnZones.join("/")} to gain map control, using utility to block sightlines and gather information on CT positions before committing to a site.`
    );
  }

  // A Site execute
  if (siteNames.includes("A")) {
    const aApproach = zones
      .filter(
        (z) =>
          (z.type === "connector" || z.type === "area") &&
          (z.name.toLowerCase().includes("a ") ||
            z.name.toLowerCase().includes("ramp") ||
            z.name.toLowerCase().includes("long") ||
            z.name.toLowerCase().includes("short"))
      )
      .map((z) => z.name);

    const approaches =
      aApproach.length > 0
        ? `through ${aApproach.join(" and ")}`
        : "with a coordinated push";
    strategies.push(
      `A Execute: Smoke off CT sightlines and push ${approaches} onto A Site. Use flashes to clear corners and plant for a defensive post-plant position.`
    );
  }

  // B Site execute
  if (siteNames.includes("B")) {
    const bApproach = zones
      .filter(
        (z) =>
          (z.type === "connector" || z.type === "area") &&
          (z.name.toLowerCase().includes("b ") ||
            z.name.toLowerCase().includes("apart") ||
            z.name.toLowerCase().includes("tunnel") ||
            z.name.toLowerCase().includes("hall"))
      )
      .map((z) => z.name);

    const approaches =
      bApproach.length > 0
        ? `through ${bApproach.join(" and ")}`
        : "with a coordinated push";
    strategies.push(
      `B Execute: Smoke off CT rotation routes and push ${approaches} onto B Site. Coordinate molotovs to clear common hiding spots before entry.`
    );
  }

  // Mid control
  const midZones = zones.filter(
    (z) =>
      z.name.toLowerCase().includes("mid") && z.type !== "spawn"
  );
  if (midZones.length > 0) {
    strategies.push(
      `Mid Control: Contest ${midZones.map((z) => z.name).join("/")} early to open up rotation options and apply pressure on both sites. Mid control enables split executes and forces CTs to spread thin.`
    );
  }

  // Retake
  if (siteNames.length >= 2) {
    strategies.push(
      `Retake Strategy: Use utility from multiple angles when retaking a site. Coordinate pushes from ${siteNames.length > 0 ? "CT Spawn and connector routes" : "multiple directions"} simultaneously to overwhelm the attackers' positional advantage.`
    );
  }

  return strategies;
}

// ─── Map Description Generation ────────────────────────────────────────────

function getMapDescription(mapData: MapData): string {
  const { displayName, zones, callouts } = mapData;
  const siteCount = Object.keys(mapData.sites).length;
  const calloutCount = callouts.length;
  const zoneTypes = [...new Set(zones.map((z) => z.type))];

  if (calloutCount === 0) {
    return `${displayName} is a competitive Counter-Strike 2 map with a unique vertical layout. Map callout data is currently unavailable.`;
  }

  const siteLetter = Object.keys(mapData.sites).join(" and ");
  const hasMid = zones.some((z) => z.name.toLowerCase().includes("mid"));

  return `${displayName} is a competitive Counter-Strike 2 map featuring ${siteLetter} Sites${hasMid ? ", a central Mid area," : ""} and ${calloutCount} named callout positions. The map has ${zones.length} defined zones including sites, spawns, connectors, and key areas.`;
}

// ─── Markdown Generation ────────────────────────────────────────────────────

function generateCalloutMd(mapData: MapData): string {
  const { displayName, sites, spawns, callouts, zones } = mapData;
  const lines: string[] = [];

  // Title
  lines.push(`# ${displayName} Callouts and Positions`);
  lines.push("");
  lines.push(
    `Complete reference for all callout positions, zones, and strategies on ${displayName} in Counter-Strike 2.`
  );
  lines.push("");

  // Sites section
  lines.push("## Sites");
  lines.push("");
  const siteKeys = Object.keys(sites);
  if (siteKeys.length > 0) {
    for (const key of siteKeys) {
      const pos = sites[key];
      lines.push(`- **${key} Site**: Position (${pos.x}, ${pos.y})`);
    }
  } else {
    lines.push("No site data available for this map.");
  }
  lines.push("");

  // Spawns section
  lines.push("## Spawns");
  lines.push("");
  const spawnKeys = Object.keys(spawns);
  if (spawnKeys.length > 0) {
    for (const key of spawnKeys) {
      const pos = spawns[key];
      lines.push(`- **${key} Spawn**: Position (${pos.x}, ${pos.y})`);
    }
  } else {
    lines.push("No spawn data available for this map.");
  }
  lines.push("");

  // All Callouts table
  lines.push("## All Callouts");
  lines.push("");
  if (callouts.length > 0) {
    lines.push("| Callout Name | X | Y | Zone |");
    lines.push("|---|---|---|---|");
    for (const c of callouts) {
      lines.push(`| ${c.name} | ${c.x} | ${c.y} | ${c.zone} |`);
    }
  } else {
    lines.push("No callout data available for this map.");
  }
  lines.push("");

  // Callout descriptions
  if (callouts.length > 0) {
    lines.push("### Callout Descriptions");
    lines.push("");
    for (const c of callouts) {
      lines.push(`- **${c.name}** (${c.zone}): ${c.description}`);
    }
    lines.push("");
  }

  // Zones section
  lines.push("## Zones");
  lines.push("");
  if (zones.length > 0) {
    for (const z of zones) {
      const typeLabel = z.type
        .replace("site", "Bombsite")
        .replace("spawn", "Spawn Area")
        .replace("connector", "Connector/Transition")
        .replace("area", "Key Area");
      lines.push(`- **${z.name}** — ${typeLabel} (centroid: ${z.centroid.x}, ${z.centroid.y})`);
    }
  } else {
    lines.push("No zone data available for this map.");
  }
  lines.push("");

  // Common Strategies
  lines.push("## Common Strategies");
  lines.push("");
  const strategies = generateStrategies(mapData);
  if (strategies.length > 0) {
    for (const s of strategies) {
      lines.push(`- ${s}`);
    }
  } else {
    lines.push(
      "Strategy suggestions will be available when more map data is provided."
    );
  }
  lines.push("");

  // Source
  if (mapData.meta?.source) {
    lines.push(`*Source: ${mapData.meta.source}*`);
    lines.push("");
  }

  return lines.join("\n");
}

function generateGuideMd(mapName: string, html: string): string | null {
  const content = stripHtml(html);
  if (content.trim().length < 100) {
    console.warn(`  Guide content too short for ${mapName}, skipping guide`);
    return null;
  }
  return content;
}

function generateIndexMd(
  mapEntries: { data: MapData; indexEntry: MapIndexEntry }[]
): string {
  const lines: string[] = [];

  lines.push("# CS2 Map Callouts Reference");
  lines.push("");
  lines.push(
    "Complete reference for Counter-Strike 2 competitive map callouts, positions, and strategies."
  );
  lines.push("");
  lines.push("## Available Maps");
  lines.push("");

  for (const { data, indexEntry } of mapEntries) {
    const desc = getMapDescription(data);
    const calloutNote =
      indexEntry.calloutCount > 0
        ? `${indexEntry.calloutCount} callouts`
        : "callout data pending";
    lines.push(
      `### [${data.displayName}](./${data.name}.md)`
    );
    lines.push("");
    lines.push(`${calloutNote} — ${desc.split(". ")[0]}.`);
    lines.push("");
  }

  lines.push("## Guide Articles");
  lines.push("");
  lines.push(
    "Detailed map guides with callout explanations from community sources:"
  );
  lines.push("");

  for (const { data } of mapEntries) {
    lines.push(
      `- [${data.displayName} Guide](./${data.name}-guide.md)`
    );
  }
  lines.push("");

  return lines.join("\n");
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Generating Map Documentation ===");
  console.log(`Maps data dir: ${MAPS_DATA_DIR}`);
  console.log(`Skinclub dir:  ${SKINCLUB_DIR}`);
  console.log(`Output dir:    ${OUTPUT_DIR}`);
  console.log("");

  // Ensure output directory exists
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Load maps index
  const indexPath = path.join(MAPS_DATA_DIR, "index.json");
  const mapIndex: { maps: MapIndexEntry[] } = JSON.parse(
    fs.readFileSync(indexPath, "utf-8")
  );
  console.log(`Found ${mapIndex.maps.length} maps in index`);

  const results: { data: MapData; indexEntry: MapIndexEntry }[] = [];
  let generatedCallouts = 0;
  let generatedGuides = 0;

  for (const indexEntry of mapIndex.maps) {
    const mapName = indexEntry.name;
    console.log(`\nProcessing: ${indexEntry.displayName} (${mapName})`);

    // Load map JSON data
    const mapJsonPath = path.join(MAPS_DATA_DIR, `${mapName}.json`);
    if (!fs.existsSync(mapJsonPath)) {
      console.warn(`  WARNING: Map data file not found: ${mapJsonPath}`);
      continue;
    }

    const mapData: MapData = JSON.parse(
      fs.readFileSync(mapJsonPath, "utf-8")
    );
    console.log(
      `  Loaded ${mapData.callouts.length} callouts, ${mapData.zones.length} zones`
    );

    // Generate callout markdown
    const calloutMd = generateCalloutMd(mapData);
    const calloutPath = path.join(OUTPUT_DIR, `${mapName}.md`);
    fs.writeFileSync(calloutPath, calloutMd, "utf-8");
    console.log(`  Written: ${calloutPath} (${calloutMd.length} chars)`);
    generatedCallouts++;

    // Generate guide from skinclub article
    const articlePath = path.join(SKINCLUB_DIR, mapName, "article.html");
    if (fs.existsSync(articlePath)) {
      const html = fs.readFileSync(articlePath, "utf-8");
      const guideMd = generateGuideMd(mapName, html);
      if (guideMd) {
        const guidePath = path.join(OUTPUT_DIR, `${mapName}-guide.md`);
        fs.writeFileSync(guidePath, guideMd, "utf-8");
        console.log(
          `  Written guide: ${guidePath} (${guideMd.length} chars)`
        );
        generatedGuides++;
      }
    } else {
      console.log(`  No skinclub article found for ${mapName}`);
    }

    results.push({ data: mapData, indexEntry });
  }

  // Generate index
  const indexMd = generateIndexMd(results);
  const indexMdPath = path.join(OUTPUT_DIR, "index.md");
  fs.writeFileSync(indexMdPath, indexMd, "utf-8");
  console.log(`\nWritten index: ${indexMdPath}`);

  // Summary
  console.log("\n=== Generation Complete ===");
  console.log(`Maps processed:      ${results.length}`);
  console.log(`Callout docs:        ${generatedCallouts}`);
  console.log(`Guide docs:          ${generatedGuides}`);
  console.log(`Index file:          1`);
  console.log(`Total new files:     ${generatedCallouts + generatedGuides + 1}`);
  console.log(`Output directory:    ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error("Generation failed:", err);
  process.exit(1);
});
