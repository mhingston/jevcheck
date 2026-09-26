import { discoverFiles } from "./files.js";
import type { JevCheckRule } from "./types.js";

function normalized(paths: readonly string[]): string[] {
  return paths.map((path) => path.replaceAll("\\", "/"));
}

export async function confirmationFixtureOverlaps(
  rule: JevCheckRule,
  cwd = process.cwd(),
): Promise<string[]> {
  const developmentPatterns = [
    ...(rule.fixtures?.valid ?? []),
    ...(rule.fixtures?.invalid ?? []),
  ];
  const confirmationPatterns = [
    ...(rule.fixtures?.confirmation?.valid ?? []),
    ...(rule.fixtures?.confirmation?.invalid ?? []),
  ];
  if (!developmentPatterns.length || !confirmationPatterns.length) return [];

  const [development, confirmation] = await Promise.all([
    discoverFiles(developmentPatterns, [], cwd),
    discoverFiles(confirmationPatterns, [], cwd),
  ]);
  const developmentSet = new Set(normalized(development));
  return [...new Set(normalized(confirmation).filter((path) => developmentSet.has(path)))].sort();
}
