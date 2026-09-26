import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  FixtureCalibrationEntry,
  FixtureDriftItem,
  FixtureDriftResult,
  FixtureDriftStale,
  FixtureTestResult,
  RuleThresholdDiagnostic,
} from "./types.js";

export const DEFAULT_CALIBRATION_FILE = ".jevcheck/calibration.json";
export const CALIBRATION_FORMAT_VERSION = 1;
export const DEFAULT_DRIFT_THRESHOLD = 0.1;
export const FIXTURE_THIN_MARGIN = 0.05;

interface CalibrationFile {
  version: number;
  fixtures: FixtureCalibrationEntry[];
}

export function fixtureCalibrationKey(
  value: Pick<FixtureCalibrationEntry, "ruleId" | "path" | "expected">,
): string {
  return [value.ruleId, value.expected, value.path.replaceAll("\\", "/")].join("\0");
}

function validateEntry(value: unknown, index: number): FixtureCalibrationEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("calibration.fixtures[" + index + "] must be an object");
  }
  const entry = value as Record<string, unknown>;
  for (const field of ["ruleId", "path"] as const) {
    if (typeof entry[field] !== "string" || !(entry[field] as string).trim()) {
      throw new Error("calibration.fixtures[" + index + "]." + field + " must be a non-empty string");
    }
  }
  if (entry.expected !== "valid" && entry.expected !== "invalid") {
    throw new Error("calibration.fixtures[" + index + "].expected must be valid or invalid");
  }
  for (const field of ["probability", "threshold"] as const) {
    if (
      typeof entry[field] !== "number" ||
      !Number.isFinite(entry[field]) ||
      entry[field] < 0 ||
      entry[field] > 1
    ) {
      throw new Error("calibration.fixtures[" + index + "]." + field + " must be between 0 and 1");
    }
  }
  if (!Array.isArray(entry.semanticKeys) || entry.semanticKeys.some(
    (item) => typeof item !== "string" || !item.trim(),
  )) {
    throw new Error("calibration.fixtures[" + index + "].semanticKeys must be an array of non-empty strings");
  }
  if (new Set(entry.semanticKeys as string[]).size !== (entry.semanticKeys as string[]).length) {
    throw new Error("calibration.fixtures[" + index + "].semanticKeys must not contain duplicates");
  }
  if (entry.model !== undefined && (typeof entry.model !== "string" || !entry.model.trim())) {
    throw new Error("calibration.fixtures[" + index + "].model must be a non-empty string");
  }

  return {
    ruleId: entry.ruleId as string,
    path: (entry.path as string).replaceAll("\\", "/"),
    expected: entry.expected as "valid" | "invalid",
    probability: entry.probability as number,
    threshold: entry.threshold as number,
    semanticKeys: [...(entry.semanticKeys as string[])].sort(),
    ...(entry.model ? { model: entry.model as string } : {}),
  };
}

export function thresholdDiagnostics(
  entries: readonly FixtureCalibrationEntry[],
): RuleThresholdDiagnostic[] {
  const byRule = new Map<string, FixtureCalibrationEntry[]>();
  for (const entry of entries) {
    const existing = byRule.get(entry.ruleId) ?? [];
    existing.push(entry);
    byRule.set(entry.ruleId, existing);
  }

  return [...byRule.entries()]
    .map(([ruleId, ruleEntries]) => {
      const valid = ruleEntries.filter((entry) => entry.expected === "valid");
      const invalid = ruleEntries.filter((entry) => entry.expected === "invalid");
      const validMax = valid.length
        ? Math.max(...valid.map((entry) => entry.probability))
        : undefined;
      const invalidMin = invalid.length
        ? Math.min(...invalid.map((entry) => entry.probability))
        : undefined;
      const currentThreshold = ruleEntries[0]?.threshold;
      const separation =
        validMax !== undefined && invalidMin !== undefined
          ? Number((invalidMin - validMax).toFixed(6))
          : undefined;

      return {
        ruleId,
        ...(validMax !== undefined ? { validMax } : {}),
        ...(invalidMin !== undefined ? { invalidMin } : {}),
        ...(separation !== undefined ? { separation } : {}),
        ...(currentThreshold !== undefined ? { currentThreshold } : {}),
        separable: separation !== undefined && separation > 0,
      };
    })
    .sort((a, b) => a.ruleId.localeCompare(b.ruleId));
}

export async function readCalibration(path: string): Promise<FixtureCalibrationEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("calibration file not found: " + path + "; run jevcheck test --record first");
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("calibration file must be an object");
  }
  const file = parsed as Record<string, unknown>;
  if (file.version !== CALIBRATION_FORMAT_VERSION) {
    throw new Error(
      "unsupported calibration format version: " +
      String(file.version) +
      " (expected " +
      CALIBRATION_FORMAT_VERSION +
      ")",
    );
  }
  if (!Array.isArray(file.fixtures)) {
    throw new Error("calibration.fixtures must be an array");
  }

  const fixtures = file.fixtures.map(validateEntry);
  const seen = new Set<string>();
  for (const fixture of fixtures) {
    const key = fixtureCalibrationKey(fixture);
    if (seen.has(key)) throw new Error("duplicate calibration fixture: " + key.replaceAll("\0", " / "));
    seen.add(key);
  }
  return fixtures;
}

export function calibrationEntries(tests: readonly FixtureTestResult[]): FixtureCalibrationEntry[] {
  for (const test of tests) {
    if (test.semanticKeys.length === 0) {
      throw new Error(
        "fixture " +
        test.ruleId +
        " / " +
        test.path +
        " produced no semantic evaluations and cannot be calibrated",
      );
    }
  }
  return tests
    .map((test) => ({
      ruleId: test.ruleId,
      path: test.path.replaceAll("\\", "/"),
      expected: test.expected,
      probability: Number(test.maxProbability.toFixed(6)),
      threshold: test.threshold,
      semanticKeys: [...test.semanticKeys].sort(),
      ...(test.model ? { model: test.model } : {}),
    }))
    .sort(
      (a, b) =>
        a.ruleId.localeCompare(b.ruleId) ||
        a.path.localeCompare(b.path) ||
        a.expected.localeCompare(b.expected),
    );
}

export async function writeCalibration(
  path: string,
  tests: readonly FixtureTestResult[],
): Promise<number> {
  const file: CalibrationFile = {
    version: CALIBRATION_FORMAT_VERSION,
    fixtures: calibrationEntries(tests),
  };
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + ".tmp";
  await writeFile(temporary, JSON.stringify(file, null, 2) + "\n", "utf8");
  await rename(temporary, path);
  return file.fixtures.length;
}

export function compareCalibration(
  recorded: readonly FixtureCalibrationEntry[],
  currentTests: readonly FixtureTestResult[],
  driftThreshold = DEFAULT_DRIFT_THRESHOLD,
): FixtureDriftResult {
  const current = calibrationEntries(currentTests);
  const beforeByKey = new Map(recorded.map((entry) => [fixtureCalibrationKey(entry), entry]));
  const afterByKey = new Map(current.map((entry) => [fixtureCalibrationKey(entry), entry]));
  const compared: FixtureDriftItem[] = [];
  const stale: FixtureDriftStale[] = [];

  for (const after of current) {
    const before = beforeByKey.get(fixtureCalibrationKey(after));
    if (!before) continue;
    const semanticInputsChanged =
      before.semanticKeys.length !== after.semanticKeys.length ||
      before.semanticKeys.some((key, index) => key !== after.semanticKeys[index]);
    const thresholdChanged = before.threshold !== after.threshold;
    if (semanticInputsChanged || thresholdChanged) {
      stale.push({
        ruleId: after.ruleId,
        path: after.path,
        expected: after.expected,
        reason: semanticInputsChanged ? "semantic-inputs" : "threshold",
        beforeSemanticKeys: before.semanticKeys,
        afterSemanticKeys: after.semanticKeys,
        beforeThreshold: before.threshold,
        afterThreshold: after.threshold,
      });
      continue;
    }
    const delta = Math.abs(after.probability - before.probability);
    compared.push({
      ruleId: after.ruleId,
      path: after.path,
      expected: after.expected,
      before: before.probability,
      after: after.probability,
      delta,
      beforeThreshold: before.threshold,
      afterThreshold: after.threshold,
      beforeModel: before.model,
      afterModel: after.model,
    });
  }

  const meanAbsoluteDelta =
    compared.reduce((sum, item) => sum + item.delta, 0) / Math.max(1, compared.length);

  return {
    compared: compared.length,
    meanAbsoluteDelta,
    moved: compared
      .filter((item) => item.delta > 0 && item.delta >= driftThreshold)
      .sort((a, b) => b.delta - a.delta || a.ruleId.localeCompare(b.ruleId) || a.path.localeCompare(b.path)),
    stale: stale.sort((a, b) => a.ruleId.localeCompare(b.ruleId) || a.path.localeCompare(b.path)),
    added: current.filter((entry) => !beforeByKey.has(fixtureCalibrationKey(entry))),
    removed: recorded.filter((entry) => !afterByKey.has(fixtureCalibrationKey(entry))),
    driftThreshold,
  };
}
