import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DEFAULT_CALIBRATION_FILE, DEFAULT_DRIFT_THRESHOLD, readCalibration } from "./calibration.js";
import {
  collectCurrentFixtureEvidence,
  evaluateRuleEvidence,
  type CurrentFixtureEvidence,
  type RuleDriftEvidence,
} from "./evidence.js";
import {
  DEFAULT_CHUNK_CHARS,
  DEFAULT_CONTEXT_LINES,
  DEFAULT_OVERLAP_LINES,
  ruleAppliesToFile,
} from "./engine.js";
import { discoverFiles } from "./files.js";
import { applyMutation, stableMutationOrder } from "./mutate.js";
import type {
  FixtureCalibrationEntry,
  FixtureDriftResult,
  FixtureRunResult,
  JevCheckConfig,
  JevCheckRule,
  RecallMutantResult,
  RecallRunResult,
  RobustnessCaseResult,
  RobustnessRunResult,
  RuleEvidenceReport,
} from "./types.js";

export const DEFAULT_EVIDENCE_FILE = ".jevcheck/evidence.json";
export const RULE_EVIDENCE_FORMAT_VERSION = 1;
const DRIFT_IDENTITY_VERSION = "v1";
const MUTATION_IDENTITY_VERSION = "v2";
const ROBUSTNESS_IDENTITY_VERSION = "v1";

export const DEFAULT_SOURCE_INCLUDE = [
  "**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts,py,go,rs,java,cs,rb,php,vue,svelte}",
];

export interface PersistedDriftEvidence extends RuleDriftEvidence {
  ruleId: string;
  identity: string;
  modelNamespace: string;
}

export interface PersistedMutationEvidence {
  ruleId: string;
  identity: string;
  modelNamespace: string;
  sampleSize: number;
  mutants: RecallMutantResult[];
}

export interface PersistedRobustnessEvidence {
  ruleId: string;
  identity: string;
  modelNamespace: string;
  cases: RobustnessCaseResult[];
}

export interface RuleEvidenceArtifact {
  version: number;
  drift: PersistedDriftEvidence[];
  mutation: PersistedMutationEvidence[];
  robustness: PersistedRobustnessEvidence[];
}

export interface ConfiguredEvidenceOptions {
  cwd?: string;
  modelNamespace: string;
}

export interface ConfiguredEvidenceResult {
  reports: RuleEvidenceReport[];
  artifact: RuleEvidenceArtifact;
  sourcePaths: string[];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function emptyArtifact(): RuleEvidenceArtifact {
  return {
    version: RULE_EVIDENCE_FORMAT_VERSION,
    drift: [],
    mutation: [],
    robustness: [],
  };
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(field + " must be a non-empty string");
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(field + " must be a non-negative safe integer");
  }
  return value as number;
}

function probability(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error(field + " must be between 0 and 1");
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error(field + " must be an array of non-empty strings");
  }
  const strings = value as string[];
  if (new Set(strings).size !== strings.length) {
    throw new Error(field + " must not contain duplicates");
  }
  return [...strings].sort();
}

function validateRecallMutant(
  value: unknown,
  field: string,
  parentRuleId: string,
): RecallMutantResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(field + " must be an object");
  }
  const item = value as Record<string, unknown>;
  const ruleId = nonEmptyString(item.ruleId, field + ".ruleId");
  const mutantId = nonEmptyString(item.mutantId, field + ".mutantId");
  if (ruleId !== parentRuleId) {
    throw new Error(field + ".ruleId must match parent ruleId " + parentRuleId);
  }

  const candidateCount = nonNegativeInteger(item.candidateCount, field + ".candidateCount");
  const sampled = nonNegativeInteger(item.sampled, field + ".sampled");
  const judged = nonNegativeInteger(item.judged, field + ".judged");
  const caught = nonNegativeInteger(item.caught, field + ".caught");
  if (sampled > candidateCount) {
    throw new Error(field + ".sampled must not exceed candidateCount");
  }
  if (judged > sampled) {
    throw new Error(field + ".judged must not exceed sampled");
  }
  if (caught > judged) {
    throw new Error(field + ".caught must not exceed judged");
  }

  const misses = stringArray(item.misses, field + ".misses");
  const invalidOriginals = stringArray(item.invalidOriginals, field + ".invalidOriginals");
  if (misses.length !== judged - caught) {
    throw new Error(field + ".misses must contain exactly judged - caught entries");
  }
  if (invalidOriginals.length !== sampled - judged) {
    throw new Error(field + ".invalidOriginals must contain exactly sampled - judged entries");
  }

  let recall: number | undefined;
  if (judged === 0) {
    if (item.recall !== undefined) {
      throw new Error(field + ".recall must be omitted when judged is 0");
    }
  } else {
    if (
      typeof item.recall !== "number" ||
      !Number.isFinite(item.recall) ||
      item.recall < 0 ||
      item.recall > 1
    ) {
      throw new Error(field + ".recall must be between 0 and 1 when judged is positive");
    }
    const expected = caught / judged;
    if (Math.abs(item.recall - expected) > Number.EPSILON * 8) {
      throw new Error(field + ".recall must equal caught / judged");
    }
    recall = item.recall;
  }

  return {
    ruleId,
    mutantId,
    candidateCount,
    sampled,
    judged,
    caught,
    ...(recall !== undefined ? { recall } : {}),
    misses,
    invalidOriginals,
  };
}

function validateRobustnessCase(
  value: unknown,
  field: string,
  parentRuleId: string,
): RobustnessCaseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(field + " must be an object");
  }
  const item = value as Record<string, unknown>;
  const ruleId = nonEmptyString(item.ruleId, field + ".ruleId");
  if (ruleId !== parentRuleId) {
    throw new Error(field + ".ruleId must match parent ruleId " + parentRuleId);
  }
  const path = nonEmptyString(item.path, field + ".path");
  if (item.expected !== "valid" && item.expected !== "invalid") {
    throw new Error(field + ".expected must be valid or invalid");
  }
  if (
    item.perturbation !== "direct-instruction" &&
    item.perturbation !== "false-authority" &&
    item.perturbation !== "irrelevant-context"
  ) {
    throw new Error(field + ".perturbation is not supported");
  }

  const baselineProbability = probability(
    item.baselineProbability,
    field + ".baselineProbability",
  );
  const perturbedProbability = probability(
    item.perturbedProbability,
    field + ".perturbedProbability",
  );
  const delta = probability(item.delta, field + ".delta");
  const threshold = probability(item.threshold, field + ".threshold");
  for (const booleanField of ["baselineViolated", "perturbedViolated", "flipped"] as const) {
    if (typeof item[booleanField] !== "boolean") {
      throw new Error(field + "." + booleanField + " must be a boolean");
    }
  }

  const expectedDelta = Math.abs(perturbedProbability - baselineProbability);
  if (Math.abs(delta - expectedDelta) > 1e-9) {
    throw new Error(field + ".delta must equal |perturbedProbability - baselineProbability|");
  }
  if (item.baselineViolated !== (baselineProbability >= threshold)) {
    throw new Error(field + ".baselineViolated is inconsistent with probability and threshold");
  }
  if (item.perturbedViolated !== (perturbedProbability >= threshold)) {
    throw new Error(field + ".perturbedViolated is inconsistent with probability and threshold");
  }
  if (item.flipped !== (item.baselineViolated !== item.perturbedViolated)) {
    throw new Error(field + ".flipped is inconsistent with the classifications");
  }
  if (item.model !== undefined && (typeof item.model !== "string" || !item.model.trim())) {
    throw new Error(field + ".model must be a non-empty string");
  }

  return {
    ruleId,
    path,
    expected: item.expected,
    perturbation: item.perturbation,
    baselineProbability,
    perturbedProbability,
    delta,
    threshold,
    baselineViolated: item.baselineViolated as boolean,
    perturbedViolated: item.perturbedViolated as boolean,
    flipped: item.flipped as boolean,
    ...(item.model ? { model: item.model as string } : {}),
  };
}

function validateArtifact(value: unknown): RuleEvidenceArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("rule evidence file must be an object");
  }
  const file = value as Record<string, unknown>;
  if (file.version !== RULE_EVIDENCE_FORMAT_VERSION) {
    throw new Error(
      "unsupported rule evidence format version: " +
        String(file.version) +
        " (expected " +
        RULE_EVIDENCE_FORMAT_VERSION +
        ")",
    );
  }
  if (!Array.isArray(file.drift) || !Array.isArray(file.mutation)) {
    throw new Error("rule evidence file must contain drift and mutation arrays");
  }
  if (file.robustness !== undefined && !Array.isArray(file.robustness)) {
    throw new Error("rule evidence robustness must be an array when present");
  }

  const drift = file.drift.map((value, index): PersistedDriftEvidence => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("evidence.drift[" + index + "] must be an object");
    }
    const item = value as Record<string, unknown>;
    for (const field of ["ruleId", "identity", "modelNamespace"] as const) {
      if (typeof item[field] !== "string" || !(item[field] as string).trim()) {
        throw new Error("evidence.drift[" + index + "]." + field + " must be non-empty");
      }
    }
    return {
      ruleId: item.ruleId as string,
      identity: item.identity as string,
      modelNamespace: item.modelNamespace as string,
      significantMovers: stringArray(item.significantMovers, "evidence.drift[" + index + "].significantMovers"),
      stale: stringArray(item.stale, "evidence.drift[" + index + "].stale"),
      added: stringArray(item.added, "evidence.drift[" + index + "].added"),
      removed: stringArray(item.removed, "evidence.drift[" + index + "].removed"),
      fixtureFailures: stringArray(item.fixtureFailures, "evidence.drift[" + index + "].fixtureFailures"),
      thinMargins: stringArray(item.thinMargins, "evidence.drift[" + index + "].thinMargins"),
    };
  });

  const mutation = file.mutation.map((value, index): PersistedMutationEvidence => {
    const field = "evidence.mutation[" + index + "]";
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(field + " must be an object");
    }
    const item = value as Record<string, unknown>;
    const ruleId = nonEmptyString(item.ruleId, field + ".ruleId");
    const identity = nonEmptyString(item.identity, field + ".identity");
    const modelNamespace = nonEmptyString(item.modelNamespace, field + ".modelNamespace");
    if (!Number.isSafeInteger(item.sampleSize) || (item.sampleSize as number) < 1) {
      throw new Error(field + ".sampleSize must be a positive safe integer");
    }
    if (!Array.isArray(item.mutants)) {
      throw new Error(field + ".mutants must be an array");
    }

    const mutants = item.mutants.map((mutant, mutantIndex) =>
      validateRecallMutant(mutant, field + ".mutants[" + mutantIndex + "]", ruleId),
    );
    const mutantIds = new Set<string>();
    for (const mutant of mutants) {
      if (mutantIds.has(mutant.mutantId)) {
        throw new Error(field + ".mutants contains duplicate mutantId: " + mutant.mutantId);
      }
      mutantIds.add(mutant.mutantId);
    }

    return {
      ruleId,
      identity,
      modelNamespace,
      sampleSize: item.sampleSize as number,
      mutants,
    };
  });

  const robustness = (file.robustness ?? []).map(
    (value, index): PersistedRobustnessEvidence => {
      const field = "evidence.robustness[" + index + "]";
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(field + " must be an object");
      }
      const item = value as Record<string, unknown>;
      const ruleId = nonEmptyString(item.ruleId, field + ".ruleId");
      const identity = nonEmptyString(item.identity, field + ".identity");
      const modelNamespace = nonEmptyString(item.modelNamespace, field + ".modelNamespace");
      if (!Array.isArray(item.cases)) {
        throw new Error(field + ".cases must be an array");
      }
      const cases = item.cases.map((candidate, caseIndex) =>
        validateRobustnessCase(candidate, field + ".cases[" + caseIndex + "]", ruleId),
      );
      const keys = new Set<string>();
      for (const candidate of cases) {
        const key = [candidate.path, candidate.expected, candidate.perturbation].join("\0");
        if (keys.has(key)) {
          throw new Error(field + ".cases contains duplicate case: " + key.replaceAll("\0", " / "));
        }
        keys.add(key);
      }
      return { ruleId, identity, modelNamespace, cases };
    },
  );

  const driftRuleIds = new Set<string>();
  for (const item of drift) {
    if (driftRuleIds.has(item.ruleId)) {
      throw new Error("evidence.drift contains duplicate ruleId: " + item.ruleId);
    }
    driftRuleIds.add(item.ruleId);
  }
  const mutationRuleIds = new Set<string>();
  for (const item of mutation) {
    if (mutationRuleIds.has(item.ruleId)) {
      throw new Error("evidence.mutation contains duplicate ruleId: " + item.ruleId);
    }
    mutationRuleIds.add(item.ruleId);
  }

  const robustnessRuleIds = new Set<string>();
  for (const item of robustness) {
    if (robustnessRuleIds.has(item.ruleId)) {
      throw new Error("evidence.robustness contains duplicate ruleId: " + item.ruleId);
    }
    robustnessRuleIds.add(item.ruleId);
  }

  return {
    version: RULE_EVIDENCE_FORMAT_VERSION,
    drift: drift.sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
    mutation: mutation.sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
    robustness: robustness.sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
  };
}

export async function readRuleEvidenceArtifact(path: string): Promise<RuleEvidenceArtifact> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyArtifact();
    throw error;
  }
  return validateArtifact(JSON.parse(raw) as unknown);
}

async function writeRuleEvidenceArtifact(
  path: string,
  artifact: RuleEvidenceArtifact,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + ".tmp";
  await writeFile(temporary, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  await rename(temporary, path);
}

function sortedFixtureEvidence(
  ruleId: string,
  fixtures: readonly CurrentFixtureEvidence[],
): CurrentFixtureEvidence[] {
  return fixtures
    .filter((item) => item.ruleId === ruleId)
    .map((item) => ({
      ...item,
      semanticKeys: [...item.semanticKeys].sort(),
    }))
    .sort(
      (a, b) =>
        a.expected.localeCompare(b.expected) ||
        a.path.localeCompare(b.path),
    );
}

function sortedCalibration(
  ruleId: string,
  calibration: readonly FixtureCalibrationEntry[],
): FixtureCalibrationEntry[] {
  return calibration
    .filter((item) => item.ruleId === ruleId)
    .map((item) => ({
      ...item,
      semanticKeys: [...item.semanticKeys].sort(),
    }))
    .sort(
      (a, b) =>
        a.expected.localeCompare(b.expected) ||
        a.path.localeCompare(b.path),
    );
}

export function driftEvidenceIdentity(
  ruleId: string,
  fixtures: readonly CurrentFixtureEvidence[],
  calibration: readonly FixtureCalibrationEntry[],
  driftThreshold: number,
  modelNamespace: string,
): string {
  return hash(JSON.stringify({
    version: DRIFT_IDENTITY_VERSION,
    kind: "drift",
    ruleId,
    fixtures: sortedFixtureEvidence(ruleId, fixtures),
    calibration: sortedCalibration(ruleId, calibration),
    driftThreshold,
    modelNamespace,
  }));
}

interface MutationIdentityOptions {
  cwd?: string;
  chunkChars?: number;
  overlapLines?: number;
  contextLines?: number;
  include?: readonly string[];
  exclude?: readonly string[];
  sampleSize: number;
  modelNamespace: string;
}

function normalizedMutationRule(rule: JevCheckRule): Record<string, unknown> {
  return {
    id: rule.id,
    question: rule.question,
    files: rule.files ?? ["**/*"],
    exclude: rule.exclude ?? [],
    prefilter: rule.prefilter ?? null,
    unless: rule.unless ?? null,
    ast: rule.ast ?? null,
    wholeFile: rule.wholeFile ?? false,
    threshold: rule.threshold ?? 0.8,
    contextLines: rule.contextLines ?? null,
    criteria: rule.criteria ?? null,
    mutants: rule.mutants ?? [],
  };
}

export async function mutationEvidenceIdentity(
  rule: JevCheckRule,
  paths: readonly string[],
  options: MutationIdentityOptions,
  measurement: readonly RecallMutantResult[] = [],
): Promise<string> {
  if (!Number.isSafeInteger(options.sampleSize) || options.sampleSize < 1) {
    throw new Error("mutation evidence sampleSize must be a positive safe integer");
  }
  const cwd = options.cwd ?? process.cwd();
  const sourceCache = new Map<string, string>();
  const scopedPaths = [...paths]
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => ruleAppliesToFile(rule, path));

  async function sourceFor(path: string): Promise<string> {
    const cached = sourceCache.get(path);
    if (cached !== undefined) return cached;
    const source = await readFile(resolve(cwd, path), "utf8");
    sourceCache.set(path, source);
    return source;
  }

  const mutants = [];
  for (const mutant of rule.mutants ?? []) {
    const candidates: Array<{ path: string; sourceHash: string }> = [];
    for (const path of scopedPaths) {
      const source = await sourceFor(path);
      if (applyMutation(source, mutant) === undefined) continue;
      candidates.push({ path, sourceHash: hash(source) });
    }

    candidates.sort((a, b) =>
      stableMutationOrder(rule.id, mutant.id, a.path)
        .localeCompare(stableMutationOrder(rule.id, mutant.id, b.path)),
    );
    mutants.push({
      mutantId: mutant.id,
      candidatePaths: candidates.map((item) => item.path),
      sampled: candidates.slice(0, options.sampleSize),
    });
  }

  return hash(JSON.stringify({
    version: MUTATION_IDENTITY_VERSION,
    kind: "mutation",
    rule: normalizedMutationRule(rule),
    candidateDefaults: {
      chunkChars: options.chunkChars ?? DEFAULT_CHUNK_CHARS,
      overlapLines: options.overlapLines ?? DEFAULT_OVERLAP_LINES,
      contextLines: options.contextLines ?? DEFAULT_CONTEXT_LINES,
    },
    scope: {
      include: [...(options.include ?? DEFAULT_SOURCE_INCLUDE)].sort(),
      exclude: [...(options.exclude ?? [])].sort(),
    },
    sampleSize: options.sampleSize,
    modelNamespace: options.modelNamespace,
    mutants,
    measurement: measurement
      .filter((item) => item.ruleId === rule.id)
      .map((item) => ({
        ruleId: item.ruleId,
        mutantId: item.mutantId,
        candidateCount: item.candidateCount,
        sampled: item.sampled,
        judged: item.judged,
        caught: item.caught,
        recall: item.recall ?? null,
        misses: [...item.misses].sort(),
        invalidOriginals: [...item.invalidOriginals].sort(),
      }))
      .sort((a, b) => a.mutantId.localeCompare(b.mutantId)),
  }));
}

function driftForRule(
  ruleId: string,
  drift: FixtureDriftResult,
  fixtures: FixtureRunResult,
): RuleDriftEvidence {
  return {
    significantMovers: drift.moved
      .filter((item) => item.ruleId === ruleId)
      .map((item) => item.path)
      .sort(),
    stale: drift.stale
      .filter((item) => item.ruleId === ruleId)
      .map((item) => item.path + " (" + item.reason + ")")
      .sort(),
    added: drift.added
      .filter((item) => item.ruleId === ruleId)
      .map((item) => item.path)
      .sort(),
    removed: drift.removed
      .filter((item) => item.ruleId === ruleId)
      .map((item) => item.path)
      .sort(),
    fixtureFailures: fixtures.tests
      .filter((item) => item.ruleId === ruleId && !item.passed)
      .map((item) => item.path)
      .sort(),
    thinMargins: fixtures.tests
      .filter((item) => item.ruleId === ruleId && item.passed && item.thinMargin)
      .map((item) => item.path)
      .sort(),
  };
}

export async function persistDriftEvidence(
  path: string,
  rules: readonly JevCheckRule[],
  currentFixtures: readonly CurrentFixtureEvidence[],
  calibration: readonly FixtureCalibrationEntry[],
  fixtureRun: FixtureRunResult,
  drift: FixtureDriftResult,
  driftThreshold: number,
  modelNamespace: string,
): Promise<void> {
  const artifact = await readRuleEvidenceArtifact(path);
  artifact.drift = rules.map((rule) => ({
    ruleId: rule.id,
    identity: driftEvidenceIdentity(
      rule.id,
      currentFixtures,
      calibration,
      driftThreshold,
      modelNamespace,
    ),
    modelNamespace,
    ...driftForRule(rule.id, drift, fixtureRun),
  }));
  await writeRuleEvidenceArtifact(path, artifact);
}

export function robustnessEvidenceIdentity(
  ruleId: string,
  fixtures: readonly CurrentFixtureEvidence[],
  modelNamespace: string,
  measurement: readonly RobustnessCaseResult[] = [],
): string {
  return hash(JSON.stringify({
    version: ROBUSTNESS_IDENTITY_VERSION,
    kind: "robustness",
    ruleId,
    fixtures: sortedFixtureEvidence(ruleId, fixtures),
    modelNamespace,
    measurement: measurement
      .filter((item) => item.ruleId === ruleId)
      .map((item) => ({
        path: item.path,
        expected: item.expected,
        perturbation: item.perturbation,
        baselineProbability: item.baselineProbability,
        perturbedProbability: item.perturbedProbability,
        delta: item.delta,
        threshold: item.threshold,
        baselineViolated: item.baselineViolated,
        perturbedViolated: item.perturbedViolated,
        flipped: item.flipped,
        model: item.model ?? null,
      }))
      .sort(
        (a, b) =>
          a.path.localeCompare(b.path) ||
          a.expected.localeCompare(b.expected) ||
          a.perturbation.localeCompare(b.perturbation),
      ),
  }));
}

export async function persistRobustnessEvidence(
  path: string,
  rules: readonly JevCheckRule[],
  currentFixtures: readonly CurrentFixtureEvidence[],
  result: RobustnessRunResult,
  modelNamespace: string,
): Promise<void> {
  const artifact = await readRuleEvidenceArtifact(path);
  artifact.robustness = [];

  for (const rule of rules) {
    const cases = result.cases.filter((item) => item.ruleId === rule.id);
    if (!cases.length) continue;
    artifact.robustness.push({
      ruleId: rule.id,
      identity: robustnessEvidenceIdentity(
        rule.id,
        currentFixtures,
        modelNamespace,
        cases,
      ),
      modelNamespace,
      cases,
    });
  }

  artifact.robustness.sort((a, b) => a.ruleId.localeCompare(b.ruleId));
  await writeRuleEvidenceArtifact(path, artifact);
}

export async function persistMutationEvidence(
  path: string,
  rules: readonly JevCheckRule[],
  result: RecallRunResult,
  sourcePaths: readonly string[],
  sampleSize: number,
  options: Omit<MutationIdentityOptions, "sampleSize">,
): Promise<void> {
  if (!Number.isSafeInteger(sampleSize) || sampleSize < 1) {
    throw new Error("mutation evidence sampleSize must be a positive safe integer");
  }
  const artifact = await readRuleEvidenceArtifact(path);
  artifact.mutation = [];

  for (const rule of rules) {
    if (!rule.mutants?.length) continue;
    artifact.mutation.push({
      ruleId: rule.id,
      identity: await mutationEvidenceIdentity(
        rule,
        sourcePaths,
        {
          ...options,
          sampleSize,
        },
        result.mutants.filter((item) => item.ruleId === rule.id),
      ),
      modelNamespace: options.modelNamespace,
      sampleSize,
      mutants: result.mutants.filter((item) => item.ruleId === rule.id),
    });
  }

  artifact.mutation.sort((a, b) => a.ruleId.localeCompare(b.ruleId));
  await writeRuleEvidenceArtifact(path, artifact);
}

export async function evaluateConfiguredRuleEvidence(
  config: JevCheckConfig,
  options: ConfiguredEvidenceOptions,
): Promise<ConfiguredEvidenceResult> {
  const cwd = options.cwd ?? process.cwd();
  const calibrationPath = resolve(cwd, config.calibrationFile ?? DEFAULT_CALIBRATION_FILE);
  const evidencePath = resolve(cwd, config.evidenceFile ?? DEFAULT_EVIDENCE_FILE);
  const snapshot = await collectCurrentFixtureEvidence(config.rules, {
    cwd,
    chunkChars: config.chunkChars,
    overlapLines: config.overlapLines,
    contextLines: config.contextLines,
  });

  let calibration: FixtureCalibrationEntry[] | undefined;
  let calibrationError: string | undefined;
  try {
    calibration = await readCalibration(calibrationPath);
  } catch (error) {
    calibrationError = error instanceof Error ? error.message : String(error);
  }

  const artifact = await readRuleEvidenceArtifact(evidencePath);
  const include = config.include ?? DEFAULT_SOURCE_INCLUDE;
  const exclude = config.exclude ?? [];
  const sourcePaths = await discoverFiles(include, exclude, cwd);
  const persistedDrift = new Map(artifact.drift.map((item) => [item.ruleId, item]));
  const persistedMutation = new Map(artifact.mutation.map((item) => [item.ruleId, item]));
  const persistedRobustness = new Map(artifact.robustness.map((item) => [item.ruleId, item]));
  const reports: RuleEvidenceReport[] = [];

  for (const rule of config.rules) {
    let drift: RuleDriftEvidence | undefined;
    let driftError: string | undefined;
    const recordedDrift = persistedDrift.get(rule.id);
    if (recordedDrift) {
      if (!calibration) {
        driftError = "persisted drift evidence cannot be verified because calibration is unavailable";
      } else {
        const expected = driftEvidenceIdentity(
          rule.id,
          snapshot.fixtures,
          calibration,
          config.driftThreshold ?? DEFAULT_DRIFT_THRESHOLD,
          options.modelNamespace,
        );
        if (recordedDrift.identity !== expected) {
          driftError = "persisted drift evidence is stale; rerun jevcheck test --drift";
        } else {
          drift = recordedDrift;
        }
      }
    }

    let mutation: RecallMutantResult[] | undefined;
    let mutationError: string | undefined;
    const recordedMutation = persistedMutation.get(rule.id);
    if (recordedMutation) {
      const expected = await mutationEvidenceIdentity(
        rule,
        sourcePaths,
        {
          cwd,
          chunkChars: config.chunkChars,
          overlapLines: config.overlapLines,
          contextLines: config.contextLines,
          include,
          exclude,
          sampleSize: recordedMutation.sampleSize,
          modelNamespace: options.modelNamespace,
        },
        recordedMutation.mutants,
      );
      if (recordedMutation.identity !== expected) {
        mutationError = "persisted mutation recall evidence is stale; rerun jevcheck recall";
      } else {
        mutation = recordedMutation.mutants;
      }
    }

    let robustness: RobustnessCaseResult[] | undefined;
    let robustnessError: string | undefined;
    const recordedRobustness = persistedRobustness.get(rule.id);
    if (recordedRobustness) {
      const expected = robustnessEvidenceIdentity(
        rule.id,
        snapshot.fixtures,
        options.modelNamespace,
        recordedRobustness.cases,
      );
      if (recordedRobustness.identity !== expected) {
        robustnessError =
          "persisted robustness evidence is stale; rerun jevcheck test --robustness";
      } else {
        robustness = recordedRobustness.cases;
      }
    }

    reports.push(
      evaluateRuleEvidence(
        rule,
        {
          fixtures: snapshot.fixtures,
          fixtureDiagnostics: snapshot.diagnostics,
          calibration,
          calibrationError,
          drift,
          driftError,
          mutation,
          mutationError,
          robustness,
          robustnessError,
        },
        config.graduation,
      ),
    );
  }

  return { reports, artifact, sourcePaths };
}
