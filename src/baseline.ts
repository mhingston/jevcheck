import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BaselineEntry, Finding } from "./types.js";

export const DEFAULT_BASELINE_FILE = ".jevcheck/baseline.json";
export const DEFAULT_SUPPRESSION_MARKER = "jevcheck-ignore";

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function normalizedFindingText(
  source: string,
  startLine: number,
  endLine: number,
): string {
  return source
    .split(/\r?\n/)
    .slice(Math.max(0, startLine - 1), Math.max(0, endLine))
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

export function findingFingerprint(
  ruleId: string,
  path: string,
  source: string,
  startLine: number,
  endLine: number,
  occurrence = 0,
): string {
  const normalized = normalizedFindingText(source, startLine, endLine);

  return createHash("sha256")
    .update(ruleId)
    .update("\0")
    .update(normalizePath(path))
    .update("\0")
    .update(normalized)
    .update("\0")
    .update(String(occurrence))
    .digest("hex")
    .slice(0, 20);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
}

export function inlineSuppressionReason(
  source: string,
  ruleId: string,
  startLine: number,
  marker = DEFAULT_SUPPRESSION_MARKER,
): string | undefined {
  const lines = source.split(/\r?\n/);
  const pattern = new RegExp(
    "^\\s*(?://|#|/\\*+|\\*|<!--)\\s*" +
      escapeRegExp(marker) +
      "\\s+" +
      escapeRegExp(ruleId) +
      "\\s+--\\s+(.+?)\\s*(?:\\*/|-->)?\\s*$",
  );

  // Bind a suppression to the finding's first line or the line immediately above it.
  // Do not scan the entire focus range: chunk-based findings can span many unrelated lines.
  for (const index of [startLine - 2, startLine - 1]) {
    if (index < 0 || index >= lines.length) continue;
    const reason = pattern.exec(lines[index])?.[1]?.trim();
    if (reason) return reason;
  }
  return undefined;
}

function validateEntry(value: unknown, index: number): BaselineEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("baseline[" + index + "] must be an object");
  }
  const entry = value as Record<string, unknown>;
  for (const field of ["ruleId", "path", "fingerprint"] as const) {
    if (typeof entry[field] !== "string" || !(entry[field] as string).trim()) {
      throw new Error("baseline[" + index + "]." + field + " must be a non-empty string");
    }
  }
  return {
    ruleId: entry.ruleId as string,
    path: normalizePath(entry.path as string),
    fingerprint: entry.fingerprint as string,
  };
}

export async function readBaseline(path: string): Promise<BaselineEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("baseline file must contain an array");
  return parsed.map(validateEntry);
}

export function baselineEntry(finding: Finding): BaselineEntry {
  return {
    ruleId: finding.ruleId,
    path: normalizePath(finding.path),
    fingerprint: finding.fingerprint,
  };
}

export function baselineScopeKey(ruleId: string, path: string): string {
  return ruleId + "\0" + normalizePath(path);
}

export async function writeBaseline(
  path: string,
  evaluatedScopes: ReadonlySet<string>,
  current: readonly BaselineEntry[],
): Promise<number> {
  const kept = (await readBaseline(path)).filter(
    (entry) => !evaluatedScopes.has(baselineScopeKey(entry.ruleId, entry.path)),
  );
  const next = [...kept, ...current].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.ruleId.localeCompare(b.ruleId) ||
      a.fingerprint.localeCompare(b.fingerprint),
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next.length;
}
