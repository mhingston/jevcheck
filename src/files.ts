import fg from "fast-glob";
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

export async function readSource(path: string): Promise<string> {
  return readFile(path, "utf8");
}
