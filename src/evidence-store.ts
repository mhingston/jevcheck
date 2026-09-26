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
  RuleEvidenceReport,
} from "./types.js";

export const DEFAULT_EVIDENCE_FILE = ".jevcheck/evidence.json";
export const RULE_EVIDENCE_FORMAT_VERSION = 1;
const EVIDENCE_IDENTITY_VERSION = "v1";

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

export interface RuleEvidenceArtifact {
  version: number;
  drift: PersistedDriftEvidence[];
  mutation: PersistedMutationEvidence[];
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
  };
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(field + " must be an array of strings");
  }
  return [...value].sort() as string[];
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
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("evidence.mutation[" + index + "] must be an object");
    }
    const item = value as Record<string, unknown>;
    for (const field of ["ruleId", "identity", "modelNamespace"] as const) {
      if (typeof item[field] !== "string" || !(item[field] as string).trim()) {
        throw new Error("evidence.mutation[" + index + "]." + field + " must be non-empty");
      }
    }
    if (!Number.isInteger(item.sampleSize) || (item.sampleSize as number) < 1) {
      throw new Error("evidence.mutation[" + index + "].sampleSize must be a positive integer");
    }
    if (!Array.isArray(item.mutants)) {
      throw new Error("evidence.mutation[" + index + "].mutants must be an array");
    }
    return {
      ruleId: item.ruleId as string,
      identity: item.identity as string,
      modelNamespace: item.modelNamespace as string,
      sampleSize: item.sampleSize as number,
      mutants: item.mutants as RecallMutantResult[],
    };
  });

  return {
    version: RULE_EVIDENCE_FORMAT_VERSION,
    drift: drift.sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
    mutation: mutation.sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
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
    version: EVIDENCE_IDENTITY_VERSION,
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
): Promise<string> {
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
    version: EVIDENCE_IDENTITY_VERSION,
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

export async function persistMutationEvidence(
  path: string,
  rules: readonly JevCheckRule[],
  result: RecallRunResult,
  sourcePaths: readonly string[],
  sampleSize: number,
  options: MutationIdentityOptions,
): Promise<void> {
  const artifact = await readRuleEvidenceArtifact(path);
  artifact.mutation = [];

  for (const rule of rules) {
    if (!rule.mutants?.length) continue;
    artifact.mutation.push({
      ruleId: rule.id,
      identity: await mutationEvidenceIdentity(rule, sourcePaths, options),
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
      const expected = await mutationEvidenceIdentity(rule, sourcePaths, {
        cwd,
        chunkChars: config.chunkChars,
        overlapLines: config.overlapLines,
        contextLines: config.contextLines,
        include,
        exclude,
        sampleSize: recordedMutation.sampleSize,
        modelNamespace: options.modelNamespace,
      });
      if (recordedMutation.identity !== expected) {
        mutationError = "persisted mutation recall evidence is stale; rerun jevcheck recall";
      } else {
        mutation = recordedMutation.mutants;
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
        },
        config.graduation,
      ),
    );
  }

  return { reports, artifact, sourcePaths };
}
