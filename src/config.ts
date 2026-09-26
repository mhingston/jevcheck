import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateAstCandidate } from "./ast.js";
import { compilePattern } from "./candidates.js";
import type { AstCandidateConfig, JevCheckConfig, JevCheckRule } from "./types.js";

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

function validateNonNegativeInteger(value: unknown, field: string): void {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) {
    throw new Error(field + " must be a non-negative integer");
  }
}

function validateAstSelector(value: Record<string, unknown>, field: string): void {
  const hasPattern = value.pattern !== undefined;
  const hasKind = value.kind !== undefined;
  const hasRule = value.rule !== undefined;
  if (Number(hasPattern) + Number(hasKind) + Number(hasRule) !== 1) {
    throw new Error(field + " must define exactly one of pattern, kind, or rule");
  }
  if (hasPattern && (typeof value.pattern !== "string" || !value.pattern.trim())) {
    throw new Error(field + ".pattern must be a non-empty string");
  }
  if (hasKind && (typeof value.kind !== "string" || !value.kind.trim())) {
    throw new Error(field + ".kind must be a non-empty string");
  }
  if (hasRule && (!value.rule || typeof value.rule !== "object" || Array.isArray(value.rule))) {
    throw new Error(field + ".rule must be an ast-grep rule object");
  }
}

function validateAst(value: unknown, ruleId: string): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(ruleId + ".ast must be an object");
  }
  const ast = value as Record<string, unknown>;
  validateAstSelector(ast, ruleId + ".ast");

  if (
    ast.language !== undefined &&
    ast.language !== "javascript" &&
    ast.language !== "typescript" &&
    ast.language !== "tsx" &&
    ast.language !== "html" &&
    ast.language !== "css"
  ) {
    throw new Error(ruleId + ".ast.language must be javascript, typescript, tsx, html, or css");
  }

  validateNonNegativeInteger(ast.contextBefore, ruleId + ".ast.contextBefore");
  validateNonNegativeInteger(ast.contextAfter, ruleId + ".ast.contextAfter");

  if (ast.context !== undefined) {
    if (!ast.context || typeof ast.context !== "object" || Array.isArray(ast.context)) {
      throw new Error(ruleId + ".ast.context must be an object");
    }
    const context = ast.context as Record<string, unknown>;
    if (context.ancestor !== undefined) {
      if (!context.ancestor || typeof context.ancestor !== "object" || Array.isArray(context.ancestor)) {
        throw new Error(ruleId + ".ast.context.ancestor must be an ast selector");
      }
      validateAstSelector(context.ancestor as Record<string, unknown>, ruleId + ".ast.context.ancestor");
    }
  }

  try {
    validateAstCandidate(ast as unknown as AstCandidateConfig);
  } catch (error) {
    throw new Error(ruleId + ".ast is invalid: " + (error instanceof Error ? error.message : String(error)));
  }
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
  validateNonNegativeInteger(rule.contextLines, rule.id + ".contextLines");
  if (rule.wholeFile !== undefined && typeof rule.wholeFile !== "boolean") {
    throw new Error(rule.id + ".wholeFile must be a boolean");
  }
  if (rule.ast !== undefined && rule.wholeFile === true) {
    throw new Error(rule.id + " cannot use ast and wholeFile together");
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

  validateAst(rule.ast, rule.id);
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
    validateNonNegativeInteger(config[field], field);
  }
  if (typeof config.chunkChars === "number" && config.chunkChars < 256) {
    throw new Error("chunkChars must be at least 256");
  }

  return {
    include: nonEmptyStrings(config.include, "include"),
    exclude: nonEmptyStrings(config.exclude, "exclude"),
    chunkChars: config.chunkChars as number | undefined,
    overlapLines: config.overlapLines as number | undefined,
    contextLines: config.contextLines as number | undefined,
    cacheFile: optionalNonEmptyString(config.cacheFile, "cacheFile"),
    baselineFile: optionalNonEmptyString(config.baselineFile, "baselineFile"),
    replayFile: optionalNonEmptyString(config.replayFile, "replayFile"),
    calibrationFile: optionalNonEmptyString(config.calibrationFile, "calibrationFile"),
    suppressionMarker: optionalNonEmptyString(config.suppressionMarker, "suppressionMarker"),
    rules,
  };
}

export async function loadConfig(filePath = "jevcheck.config.json"): Promise<JevCheckConfig> {
  const absolute = resolve(filePath);
  const raw = await readFile(absolute, "utf8");
  return parseConfig(JSON.parse(raw) as unknown);
}
