/**
 * Load and parse the category index from the full-index.json file.
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

const INDEX_PATH = process.env.CATEGORY_INDEX_PATH || "/home/ubuntu/cs-knowledge/categories/full-index.json";

let cachedIndex: CategoryIndex | null = null;

/**
 * Load the category index from disk.
 * Results are cached in memory.
 */
export function loadCategoryIndex(): CategoryIndex {
  if (cachedIndex) return cachedIndex;

  try {
    if (fs.existsSync(INDEX_PATH)) {
      const raw = fs.readFileSync(INDEX_PATH, "utf-8");
      cachedIndex = JSON.parse(raw);
      return cachedIndex!;
    }
  } catch (error) {
    console.error("[categories] Error loading index:", error);
  }

  // Return a fallback index with placeholder categories
  cachedIndex = {
    categories: [
      { id: "algorithms", name: "Algorithms", description: "Sorting, searching, graph algorithms, and complexity analysis", icon: "⚡", documentCount: 0 },
      { id: "data-structures", name: "Data Structures", description: "Trees, graphs, hash tables, and more", icon: "🌳", documentCount: 0 },
      { id: "operating-systems", name: "Operating Systems", description: "Process management, memory, file systems", icon: "🖥️", documentCount: 0 },
      { id: "networks", name: "Computer Networks", description: "TCP/IP, routing, protocols, and security", icon: "🌐", documentCount: 0 },
      { id: "databases", name: "Databases", description: "SQL, NoSQL, indexing, and transactions", icon: "🗄️", documentCount: 0 },
      { id: "distributed-systems", name: "Distributed Systems", description: "Consensus, replication, CAP theorem", icon: "🔗", documentCount: 0 },
      { id: "programming-languages", name: "Programming Languages", description: "Language design, compilers, type systems", icon: "🔧", documentCount: 0 },
      { id: "security", name: "Cybersecurity", description: "Cryptography, attacks, secure coding", icon: "🔒", documentCount: 0 },
      { id: "ai-ml", name: "AI & Machine Learning", description: "Neural networks, training, inference", icon: "🧠", documentCount: 0 },
      { id: "system-design", name: "System Design", description: "Architecture patterns, scalability, trade-offs", icon: "📐", documentCount: 0 },
      { id: "math", name: "Math for CS", description: "Discrete math, linear algebra, probability", icon: "📊", documentCount: 0 },
      { id: "devops", name: "DevOps & Cloud", description: "CI/CD, containers, cloud platforms", icon: "☁️", documentCount: 0 },
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
