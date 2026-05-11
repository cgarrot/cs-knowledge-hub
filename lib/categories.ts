/**
 * Load and parse the category index from the full-index.json file.
 * The actual file is an array of entries with category/subcategory fields.
 */

import fs from "fs";
import path from "path";

export interface Category {
  id: string;
  name: string;
  description: string;
  icon: string;
  documentCount: number;
  subcategories?: string[];
}

export interface CategoryIndex {
  categories: Category[];
  generatedAt: string;
  totalDocuments: number;
}

interface IndexEntry {
  file: string;
  category: string;
  subcategory: string;
  skill_level: string;
  language: string;
  topics: string[];
  summary: string;
}

const INDEX_PATH =
  process.env.CATEGORY_INDEX_PATH ||
  path.join(process.env.DATA_DIR || "/data", "categories", "full-index.json");

let cachedIndex: CategoryIndex | null = null;

/**
 * Load the category index from disk.
 * Handles the actual array format of full-index.json.
 * Results are cached in memory.
 */
export function loadCategoryIndex(): CategoryIndex {
  if (cachedIndex) return cachedIndex;

  try {
    if (fs.existsSync(INDEX_PATH)) {
      const raw = fs.readFileSync(INDEX_PATH, "utf-8");
      const entries: IndexEntry[] = JSON.parse(raw);

      // Build categories from the actual data
      const catMap = new Map<string, { count: number; subs: Set<string> }>();
      for (const entry of entries) {
        const cat = entry.category;
        if (!catMap.has(cat)) {
          catMap.set(cat, { count: 0, subs: new Set<string>() });
        }
        const info = catMap.get(cat)!;
        info.count++;
        if (entry.subcategory) {
          info.subs.add(entry.subcategory);
        }
      }

      // Category metadata
      const catMeta: Record<string, { name: string; description: string; icon: string }> = {
        "demo-analysis": { name: "Demo Analysis", description: "Professional demo reviews and tactical breakdowns", icon: "🎬" },
        mindset: { name: "Mindset", description: "Mental game, motivation, and tournament preparation", icon: "🧠" },
        strategy: { name: "Strategy", description: "Map control, defaults, and tactical approaches", icon: "♟️" },
        maps: { name: "Maps", description: "Map-specific guides and positioning", icon: "🗺️" },
        aim: { name: "Aim", description: "Aim training, crosshair, and mechanical skills", icon: "🎯" },
        utility: { name: "Utility", description: "Grenade lineups and utility usage", icon: "💣" },
        "game-sense": { name: "Game Sense", description: "Decision-making, timing, and awareness", icon: "👁️" },
        communication: { name: "Communication", description: "Team comms, callouts, and coordination", icon: "📢" },
        warmup: { name: "Warmup", description: "Warmup routines and practice regimens", icon: "🏋️" },
        meta: { name: "Meta", description: "Current meta, updates, and trends", icon: "📊" },
        general: { name: "General", description: "General CS2 tips and information", icon: "📘" },
      };

      const categories: Category[] = [];
      for (const [id, info] of catMap) {
        const meta = catMeta[id] || {
          name: id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
          description: `${id} guides and resources`,
          icon: "📄",
        };
        categories.push({
          id,
          name: meta.name,
          description: meta.description,
          icon: meta.icon,
          documentCount: info.count,
          subcategories: Array.from(info.subs).sort(),
        });
      }

      // Sort by document count descending
      categories.sort((a, b) => b.documentCount - a.documentCount);

      cachedIndex = {
        categories,
        generatedAt: new Date().toISOString(),
        totalDocuments: entries.length,
      };
      return cachedIndex!;
    }
  } catch (error) {
    console.error("[categories] Error loading index:", error);
  }

  // Return a fallback index
  cachedIndex = {
    categories: [
      { id: "demo-analysis", name: "Demo Analysis", description: "Professional demo reviews and tactical breakdowns", icon: "🎬", documentCount: 0 },
      { id: "mindset", name: "Mindset", description: "Mental game, motivation, and tournament preparation", icon: "🧠", documentCount: 0 },
      { id: "strategy", name: "Strategy", description: "Map control, defaults, and tactical approaches", icon: "♟️", documentCount: 0 },
      { id: "maps", name: "Maps", description: "Map-specific guides and positioning", icon: "🗺️", documentCount: 0 },
      { id: "aim", name: "Aim", description: "Aim training, crosshair, and mechanical skills", icon: "🎯", documentCount: 0 },
    ],
    generatedAt: new Date().toISOString(),
    totalDocuments: 0,
  };

  return cachedIndex;
}

/**
 * Get a single category by ID.
 */
export function getCategory(categoryId: string): Category | undefined {
  const index = loadCategoryIndex();
  return index.categories.find((c) => c.id === categoryId);
}

/**
 * Get all category IDs.
 */
export function getCategoryIds(): string[] {
  return loadCategoryIndex().categories.map((c) => c.id);
}
