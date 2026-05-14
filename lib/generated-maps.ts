import fs from "fs";
import path from "path";

export const GENERATED_MAPS_DIR = path.join(process.cwd(), "public", "generated-maps");

const GENERATED_MAP_MAX_FILES = 60;
const GENERATED_MAP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const GENERATED_MAP_PATTERN = /^[a-z0-9]+-\d+\.svg$/;

export interface GeneratedMapFile {
  filename: string;
  filePath: string;
  url: string;
}

export function ensureGeneratedMapsDir(): void {
  if (!fs.existsSync(GENERATED_MAPS_DIR)) {
    fs.mkdirSync(GENERATED_MAPS_DIR, { recursive: true });
  }
}

function listGeneratedMapFiles(): Array<{ filename: string; filePath: string; mtimeMs: number }> {
  if (!fs.existsSync(GENERATED_MAPS_DIR)) return [];

  return fs.readdirSync(GENERATED_MAPS_DIR)
    .filter((filename) => GENERATED_MAP_PATTERN.test(filename))
    .flatMap((filename) => {
      const filePath = path.join(GENERATED_MAPS_DIR, filename);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return [];
        return [{ filename, filePath, mtimeMs: stat.mtimeMs }];
      } catch {
        return [];
      }
    });
}

export function pruneGeneratedMaps(now = Date.now()): void {
  const generatedFiles = listGeneratedMapFiles();
  const freshFiles: Array<{ filename: string; filePath: string; mtimeMs: number }> = [];

  for (const file of generatedFiles) {
    if (now - file.mtimeMs > GENERATED_MAP_MAX_AGE_MS) {
      try {
        fs.unlinkSync(file.filePath);
      } catch (error) {
        console.warn(`[generated-maps] Failed to prune old map ${file.filename}:`, error);
      }
      continue;
    }
    freshFiles.push(file);
  }

  freshFiles
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(GENERATED_MAP_MAX_FILES)
    .forEach((file) => {
      try {
        fs.unlinkSync(file.filePath);
      } catch (error) {
        console.warn(`[generated-maps] Failed to prune excess map ${file.filename}:`, error);
      }
    });
}

export function writeGeneratedMapSvg(mapName: string, svg: string): GeneratedMapFile | null {
  ensureGeneratedMapsDir();
  pruneGeneratedMaps();

  const timestamp = Date.now();
  const safeMapName = mapName.replace(/[^a-z0-9]/g, "");
  if (!safeMapName) return null;

  const filename = `${safeMapName}-${timestamp}.svg`;
  const filePath = path.join(GENERATED_MAPS_DIR, filename);
  fs.writeFileSync(filePath, svg, "utf-8");
  pruneGeneratedMaps();

  return {
    filename,
    filePath,
    url: `/api/generated-maps/${filename}`,
  };
}
