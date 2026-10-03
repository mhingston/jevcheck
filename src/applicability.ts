import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { discoverFiles } from "./files.js";
import type { ProjectCondition } from "./types.js";

function projectPath(cwd: string, path: string): string {
  if (isAbsolute(path)) throw new Error("project condition paths must be repository-relative: " + path);
  const root = resolve(cwd);
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw new Error("project condition paths must stay inside the repository: " + path);
  }
  return absolute;
}

function projectPattern(pattern: string): string {
  if (isAbsolute(pattern) || pattern.replaceAll("\\", "/").split("/").includes("..")) {
    throw new Error("project condition globs must stay inside the repository: " + pattern);
  }
  return pattern;
}

async function packageJsonHasDependency(cwd: string, dependency: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(resolve(cwd, "package.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const value = parsed[field];
    if (value && typeof value === "object" && !Array.isArray(value) && dependency in value) {
      return true;
    }
  }
  return false;
}

export async function projectConditionMatches(
  condition: ProjectCondition,
  cwd = process.cwd(),
): Promise<boolean> {
  if ("packageJsonHasDep" in condition) {
    return packageJsonHasDependency(cwd, condition.packageJsonHasDep);
  }
  if ("fileExists" in condition) {
    try {
      await stat(projectPath(cwd, condition.fileExists));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  if ("globMatches" in condition) {
    return (await discoverFiles([projectPattern(condition.globMatches)], [], cwd)).length > 0;
  }
  if ("anyOf" in condition) {
    for (const item of condition.anyOf) {
      if (await projectConditionMatches(item, cwd)) return true;
    }
    return false;
  }
  if ("allOf" in condition) {
    for (const item of condition.allOf) {
      if (!(await projectConditionMatches(item, cwd))) return false;
    }
    return true;
  }
  return !(await projectConditionMatches(condition.not, cwd));
}

export function describeProjectCondition(condition: ProjectCondition): string {
  if ("packageJsonHasDep" in condition) return "package.json has dependency " + condition.packageJsonHasDep;
  if ("fileExists" in condition) return "file exists: " + condition.fileExists;
  if ("globMatches" in condition) return "glob matches: " + condition.globMatches;
  if ("anyOf" in condition) return "any of (" + condition.anyOf.map(describeProjectCondition).join("; ") + ")";
  if ("allOf" in condition) return "all of (" + condition.allOf.map(describeProjectCondition).join("; ") + ")";
  return "not (" + describeProjectCondition(condition.not) + ")";
}
