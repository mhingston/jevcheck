import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { validateAstCandidate } from "./ast.js";
import { AST_LANGUAGES, isAstLanguage } from "./ast-languages.js";
import { compilePattern } from "./candidates.js";
import { parseRuleEvidencePolicy } from "./evidence.js";
import type { AstCandidateConfig, JevCheckConfig, JevCheckRule } from "./types.js";

// These are jevcheck-owned config keys. ast.rule is intentionally opaque: its
// nested schema belongs to ast-grep and must not be frozen by our validator.
const CONFIG_FIELDS = [
  "include", "exclude", "chunkChars", "overlapLines", "contextLines",
  "cacheFile", "baselineFile", "replayFile", "calibrationFile", "confirmationFile",
  "evidenceFile", "driftThreshold", "graduation", "suppressionMarker", "rules",
] as const satisfies readonly (keyof JevCheckConfig)[];

const RULE_FIELDS = [
  "id", "question", "why", "source", "severity", "status", "files", "exclude",
  "contains", "prefilter", "unless", "ast", "wholeFile", "threshold",
  "contextLines", "criteria", "projectWhen", "coveredBy", "fixtures", "mutants",
] as const satisfies readonly (keyof JevCheckRule | "contains")[];

const AST_SELECTOR_FIELDS = ["pattern", "kind", "rule"] as const;
const AST_FIELDS = [
  ...AST_SELECTOR_FIELDS, "language", "contextBefore", "contextAfter", "context",
] as const;
const FIXTURE_FIELDS = ["valid", "invalid"] as const;

// Small Levenshtein check for actionable typo hints, not fuzzy acceptance.
function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current.push(Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      ));
    }
    previous = current;
  }
  return previous[right.length]!;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    const close = allowed
      .map((candidate) => ({ candidate, distance: editDistance(key, candidate) }))
      .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))[0];
    const hint = close && close.distance <= Math.min(3, Math.max(2, Math.floor(key.length / 3)))
      ? " (did you mean " + close.candidate + "?)"
      : "";
    throw new Error(path + "." + key + ": unknown field" + hint);
  }
}

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

// Encode a literal string for the existing deterministic regex filter.
function literalPattern(value: string): string {
  return value.replace(/[.*+?^$()|[\]{}\\/]/g, "\\$&");
}

function validateNonNegativeInteger(value: unknown, field: string): void {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) {
    throw new Error(field + " must be a non-negative integer");
  }
}

function validateAstSelector(
  value: Record<string, unknown>,
  field: string,
  allowedFields: readonly string[] = AST_SELECTOR_FIELDS,
): void {
  rejectUnknownKeys(value, allowedFields, field);
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
  validateAstSelector(ast, ruleId + ".ast", AST_FIELDS);

  if (ast.language !== undefined && !isAstLanguage(ast.language)) {
    throw new Error(ruleId + ".ast.language must be " + AST_LANGUAGES.join(", "));
  }

  validateNonNegativeInteger(ast.contextBefore, ruleId + ".ast.contextBefore");
  validateNonNegativeInteger(ast.contextAfter, ruleId + ".ast.contextAfter");

  if (ast.context !== undefined) {
    if (!ast.context || typeof ast.context !== "object" || Array.isArray(ast.context)) {
      throw new Error(ruleId + ".ast.context must be an object");
    }
    const context = ast.context as Record<string, unknown>;
    rejectUnknownKeys(context, ["ancestor"], ruleId + ".ast.context");
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


function validateRepositoryRelativePath(value: string, field: string, glob = false): void {
  const normalized = value.replaceAll("\\", "/");
  if (isAbsolute(value) || normalized.split("/").includes("..")) {
    throw new Error(field + " must stay inside the repository");
  }
  if (!glob && (normalized === "." || normalized === "")) {
    throw new Error(field + " must name a repository-relative file");
  }
}

function validateProjectCondition(value: unknown, field: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(field + " must be an object");
  }
  const condition = value as Record<string, unknown>;
  const supported = ["hasDependency", "packageJsonHasDep", "fileExists", "globMatches", "anyOf", "allOf", "not"];
  const present = supported.filter((key) => condition[key] !== undefined);
  const unknown = Object.keys(condition).filter((key) => !supported.includes(key));
  if (unknown.length) {
    throw new Error(field + " contains unknown field(s): " + unknown.join(", "));
  }
  if (present.length !== 1 || Object.keys(condition).length !== 1) {
    throw new Error(field + " must define exactly one project condition");
  }

  const key = present[0]!;
  if (key === "hasDependency") {
    const value = condition.hasDependency;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(field + ".hasDependency must be an object");
    }
    const dep = value as Record<string, unknown>;
    rejectUnknownKeys(dep, ["ecosystem", "name", "scope"], field + ".hasDependency");
    if (!["node", "dotnet", "go"].includes(String(dep.ecosystem))) {
      throw new Error(field + ".hasDependency.ecosystem must be node, dotnet, or go");
    }
    if (typeof dep.name !== "string" || !dep.name.trim()) {
      throw new Error(field + ".hasDependency.name must be a non-empty string");
    }
    if (dep.scope !== undefined && dep.scope !== "root" && dep.scope !== "workspace") {
      throw new Error(field + ".hasDependency.scope must be root or workspace");
    }
    return;
  }
  if (key === "packageJsonHasDep" || key === "fileExists" || key === "globMatches") {
    const raw = condition[key];
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error(field + "." + key + " must be a non-empty string");
    }
    if (key === "fileExists") validateRepositoryRelativePath(raw, field + "." + key);
    if (key === "globMatches") validateRepositoryRelativePath(raw, field + "." + key, true);
    return;
  }

  if (key === "not") {
    validateProjectCondition(condition.not, field + ".not");
    return;
  }

  const nested = condition[key];
  if (!Array.isArray(nested) || nested.length === 0) {
    throw new Error(field + "." + key + " must be a non-empty array");
  }
  nested.forEach((item, index) => validateProjectCondition(item, field + "." + key + "[" + index + "]"));
}

function validateCoveredBy(value: unknown, ruleId: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(ruleId + ".coveredBy must be a non-empty array");
  }
  const ids = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const field = ruleId + ".coveredBy[" + index + "]";
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(field + " must be an object");
    }
    const link = raw as Record<string, unknown>;
    const unknown = Object.keys(link).filter((key) => key !== "id" && key !== "path");
    if (unknown.length) throw new Error(field + " contains unknown field(s): " + unknown.join(", "));
    if (typeof link.id !== "string" || !link.id.trim()) throw new Error(field + ".id must be non-empty");
    if (ids.has(link.id)) throw new Error(ruleId + ".coveredBy contains duplicate id: " + link.id);
    ids.add(link.id);
    if (typeof link.path !== "string" || !link.path.trim()) throw new Error(field + ".path must be non-empty");
    validateRepositoryRelativePath(link.path, field + ".path");
  }
}

function validateRule(value: unknown, index: number): JevCheckRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("rules[" + index + "] must be an object");
  }

  const rule = value as Record<string, unknown>;
  rejectUnknownKeys(rule, RULE_FIELDS, "rules[" + index + "]");
  if (typeof rule.id !== "string" || !rule.id.trim()) throw new Error("rules[" + index + "].id must be non-empty");
  if (typeof rule.question !== "string" || !rule.question.trim()) {
    throw new Error("rules[" + index + "].question must be non-empty");
  }
  // Normalize JSON shorthands before candidate selection and evidence fingerprints.
  const normalizedRule = { ...rule };
  if (rule.contains !== undefined) {
    const literal = optionalNonEmptyString(rule.contains, rule.id + ".contains")!;
    if (rule.prefilter !== undefined) {
      throw new Error(rule.id + " cannot use contains and prefilter together");
    }
    normalizedRule.prefilter = literalPattern(literal);
  }
  delete normalizedRule.contains;
  if (typeof rule.ast === "string") {
    const kind = optionalNonEmptyString(rule.ast, rule.id + ".ast")!;
    normalizedRule.ast = { kind };
  }

  if (rule.severity !== undefined && rule.severity !== "error" && rule.severity !== "warning") {
    throw new Error(rule.id + ".severity must be error or warning");
  }
  if (rule.status !== undefined && rule.status !== "shadow" && rule.status !== "owned") {
    throw new Error(rule.id + ".status must be shadow or owned");
  }
  if (
    rule.threshold !== undefined &&
    (typeof rule.threshold !== "number" ||
      !Number.isFinite(rule.threshold) ||
      rule.threshold < 0 ||
      rule.threshold > 1)
  ) {
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
    const raw = normalizedRule[field];
    if (raw !== undefined) {
      if (typeof raw !== "string" || !raw.trim()) throw new Error(rule.id + "." + field + " must be non-empty");
      try {
        compilePattern(raw);
      } catch (error) {
        throw new Error(rule.id + "." + field + " is not a valid regular expression: " + String(error));
      }
    }
  }

  validateAst(normalizedRule.ast, rule.id);
  if (rule.projectWhen !== undefined) {
    validateProjectCondition(rule.projectWhen, rule.id + ".projectWhen");
  }
  validateCoveredBy(rule.coveredBy, rule.id);
  nonEmptyStrings(rule.files, rule.id + ".files");
  nonEmptyStrings(rule.exclude, rule.id + ".exclude");

  if (rule.criteria !== undefined) {
    if (!rule.criteria || typeof rule.criteria !== "object" || Array.isArray(rule.criteria)) {
      throw new Error(rule.id + ".criteria must be an object");
    }
    const criteria = rule.criteria as Record<string, unknown>;
    rejectUnknownKeys(criteria, ["true", "false"], "rules[" + index + "].criteria");
    optionalNonEmptyString(criteria.true, rule.id + ".criteria.true");
    optionalNonEmptyString(criteria.false, rule.id + ".criteria.false");
  }

  if (rule.fixtures !== undefined) {
    if (!rule.fixtures || typeof rule.fixtures !== "object" || Array.isArray(rule.fixtures)) {
      throw new Error(rule.id + ".fixtures must be an object");
    }
    const fixtures = rule.fixtures as Record<string, unknown>;
    rejectUnknownKeys(fixtures, [...FIXTURE_FIELDS, "confirmation"], "rules[" + index + "].fixtures");
    nonEmptyStrings(fixtures.valid, rule.id + ".fixtures.valid");
    nonEmptyStrings(fixtures.invalid, rule.id + ".fixtures.invalid");
    if (fixtures.confirmation !== undefined) {
      if (
        !fixtures.confirmation ||
        typeof fixtures.confirmation !== "object" ||
        Array.isArray(fixtures.confirmation)
      ) {
        throw new Error(rule.id + ".fixtures.confirmation must be an object");
      }
      const confirmation = fixtures.confirmation as Record<string, unknown>;
      rejectUnknownKeys(confirmation, FIXTURE_FIELDS, "rules[" + index + "].fixtures.confirmation");
      nonEmptyStrings(confirmation.valid, rule.id + ".fixtures.confirmation.valid");
      nonEmptyStrings(confirmation.invalid, rule.id + ".fixtures.confirmation.invalid");
    }
  }

  if (rule.mutants !== undefined) {
    if (!Array.isArray(rule.mutants) || rule.mutants.length === 0) {
      throw new Error(rule.id + ".mutants must be a non-empty array");
    }
    const mutantIds = new Set<string>();
    for (const [mutantIndex, value] of rule.mutants.entries()) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(rule.id + ".mutants[" + mutantIndex + "] must be an object");
      }
      const mutant = value as Record<string, unknown>;
      rejectUnknownKeys(mutant, ["id", "pattern", "replacement", "replaceAll"], "rules[" + index + "].mutants[" + mutantIndex + "]");
      if (typeof mutant.id !== "string" || !mutant.id.trim()) {
        throw new Error(rule.id + ".mutants[" + mutantIndex + "].id must be non-empty");
      }
      if (mutantIds.has(mutant.id)) {
        throw new Error(rule.id + ".mutants contains duplicate id: " + mutant.id);
      }
      mutantIds.add(mutant.id);
      if (typeof mutant.pattern !== "string" || !mutant.pattern.trim()) {
        throw new Error(rule.id + ".mutants[" + mutantIndex + "].pattern must be non-empty");
      }
      if (typeof mutant.replacement !== "string") {
        throw new Error(rule.id + ".mutants[" + mutantIndex + "].replacement must be a string");
      }
      if (mutant.replaceAll !== undefined && typeof mutant.replaceAll !== "boolean") {
        throw new Error(rule.id + ".mutants[" + mutantIndex + "].replaceAll must be a boolean");
      }
      try {
        compilePattern(mutant.pattern, mutant.replaceAll === true);
      } catch (error) {
        throw new Error(
          rule.id +
          ".mutants[" +
          mutantIndex +
          "].pattern is not a valid regular expression: " +
          String(error),
        );
      }
    }
  }

  return normalizedRule as unknown as JevCheckRule;
}

export function parseConfig(value: unknown): JevCheckConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config must be an object");
  const config = value as Record<string, unknown>;
  rejectUnknownKeys(config, CONFIG_FIELDS, "config");
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
  if (
    config.driftThreshold !== undefined &&
    (typeof config.driftThreshold !== "number" ||
      !Number.isFinite(config.driftThreshold) ||
      config.driftThreshold < 0 ||
      config.driftThreshold > 1)
  ) {
    throw new Error("driftThreshold must be between 0 and 1");
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
    confirmationFile: optionalNonEmptyString(config.confirmationFile, "confirmationFile"),
    evidenceFile: optionalNonEmptyString(config.evidenceFile, "evidenceFile"),
    driftThreshold: config.driftThreshold as number | undefined,
    graduation: parseRuleEvidencePolicy(config.graduation),
    suppressionMarker: optionalNonEmptyString(config.suppressionMarker, "suppressionMarker"),
    rules,
  };
}

export async function loadConfig(filePath = "jevcheck.config.json"): Promise<JevCheckConfig> {
  const absolute = resolve(filePath);
  const raw = await readFile(absolute, "utf8");
  return parseConfig(JSON.parse(raw) as unknown);
}
