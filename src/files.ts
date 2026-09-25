import fg from "fast-glob";
import { minimatch } from "minimatch";
import { readFile } from "node:fs/promises";

const DEFAULT_IGNORES = [
  ".git/**",
  "node_modules/**",
  "dist/**",
  "build/**",
  "coverage/**",
  ".jevcheck/**",
];

export async function discoverFiles(
  patterns: string[],
  exclude: string[] = [],
  cwd = process.cwd(),
): Promise<string[]> {
  const files = await fg(patterns, {
    cwd,
    onlyFiles: true,
    unique: true,
    dot: false,
    ignore: [...DEFAULT_IGNORES, ...exclude],
  });
  return files.sort();
}

export function filterFiles(paths: string[], include: string[], exclude: string[] = []): string[] {
  return paths
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => include.some((pattern) => minimatch(path, pattern, { dot: true })))
    .filter((path) => !exclude.some((pattern) => minimatch(path, pattern, { dot: true })))
    .sort();
}

export async function readSource(path: string): Promise<string> {
  return readFile(path, "utf8");
}
