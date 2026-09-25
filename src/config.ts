import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compilePattern } from "./candidates.js";
import type { JevCheckConfig, JevCheckRule } from "./types.js";

function nonEmptyStrings(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(field + " must be an array of non-empty strings");
  }
  return value as string[];
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(field + " must be a non-empty string");
  return value;
}

function validateRule(value: unknown, index: number): JevCheckRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("rules[" + index + "] must be an object");
  }

  const rule = value as Record<string, unknown>;
  if (typeof rule.id !== "string" || !rule.id.trim()) throw new Error("rules[" + index + "].id must be non-empty");
  if (typeof rule.question !== "string" || !rule.question.trim()) {
    throw new Error("rules[" + index + "].question must be non-empty");
  }
  if (rule.severity !== undefined && rule.severity !== "error" && rule.severity !== "warning") {
    throw new Error(rule.id + ".severity must be error or warning");
  }
  if (rule.status !== undefined && rule.status !== "shadow" && rule.status !== "owned") {
    throw new Error(rule.id + ".status must be shadow or owned");
  }
  if (rule.threshold !== undefined && (typeof rule.threshold !== "number" || rule.threshold < 0 || rule.threshold > 1)) {
    throw new Error(rule.id + ".threshold must be between 0 and 1");
  }
  if (rule.contextLines !== undefined && (!Number.isInteger(rule.contextLines) || (rule.contextLines as number) < 0)) {
    throw new Error(rule.id + ".contextLines must be a non-negative integer");
  }
  if (rule.wholeFile !== undefined && typeof rule.wholeFile !== "boolean") {
    throw new Error(rule.id + ".wholeFile must be a boolean");
  }

  optionalNonEmptyString(rule.why, rule.id + ".why");
  optionalNonEmptyString(rule.source, rule.id + ".source");

  for (const field of ["prefilter", "unless"] as const) {
    const raw = rule[field];
    if (raw !== undefined) {
      if (typeof raw !== "string" || !raw.trim()) throw new Error(rule.id + "." + field + " must be non-empty");
      try {
        compilePattern(raw);
      } catch (error) {
        throw new Error(rule.id + "." + field + " is not a valid regular expression: " + String(error));
      }
    }
  }

  nonEmptyStrings(rule.files, rule.id + ".files");
  nonEmptyStrings(rule.exclude, rule.id + ".exclude");

  if (rule.criteria !== undefined) {
    if (!rule.criteria || typeof rule.criteria !== "object" || Array.isArray(rule.criteria)) {
      throw new Error(rule.id + ".criteria must be an object");
    }
    const criteria = rule.criteria as Record<string, unknown>;
    optionalNonEmptyString(criteria.true, rule.id + ".criteria.true");
    optionalNonEmptyString(criteria.false, rule.id + ".criteria.false");
  }

  if (rule.fixtures !== undefined) {
    if (!rule.fixtures || typeof rule.fixtures !== "object" || Array.isArray(rule.fixtures)) {
      throw new Error(rule.id + ".fixtures must be an object");
    }
    const fixtures = rule.fixtures as Record<string, unknown>;
    nonEmptyStrings(fixtures.valid, rule.id + ".fixtures.valid");
    nonEmptyStrings(fixtures.invalid, rule.id + ".fixtures.invalid");
  }

  return rule as unknown as JevCheckRule;
}

export function parseConfig(value: unknown): JevCheckConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config must be an object");
  const config = value as Record<string, unknown>;
  if (!Array.isArray(config.rules) || config.rules.length === 0) throw new Error("config.rules must contain at least one rule");

  const rules = config.rules.map(validateRule);
  const ids = new Set<string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) throw new Error("duplicate rule id: " + rule.id);
    ids.add(rule.id);
  }

  for (const field of ["chunkChars", "overlapLines", "contextLines"] as const) {
    const raw = config[field];
    if (raw !== undefined && (!Number.isInteger(raw) || (raw as number) < 0)) {
      throw new Error(field + " must be a non-negative integer");
    }
  }
  if (typeof config.chunkChars === "number" && config.chunkChars < 256) {
    throw new Error("chunkChars must be at least 256");
  }
  if (config.cacheFile !== undefined && (typeof config.cacheFile !== "string" || !config.cacheFile.trim())) {
    throw new Error("cacheFile must be a non-empty string");
  }

  return {
    include: nonEmptyStrings(config.include, "include"),
    exclude: nonEmptyStrings(config.exclude, "exclude"),
    chunkChars: config.chunkChars as number | undefined,
    overlapLines: config.overlapLines as number | undefined,
    contextLines: config.contextLines as number | undefined,
    cacheFile: config.cacheFile as string | undefined,
    rules,
  };
}

export async function loadConfig(filePath = "jevcheck.config.json"): Promise<JevCheckConfig> {
  const absolute = resolve(filePath);
  const raw = await readFile(absolute, "utf8");
  return parseConfig(JSON.parse(raw) as unknown);
}
