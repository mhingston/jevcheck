import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FIXTURE_THIN_MARGIN, fixtureCalibrationKey } from "./calibration.js";
import { buildCandidates } from "./candidates.js";
import {
  DEFAULT_CHUNK_CHARS,
  DEFAULT_CONTEXT_LINES,
  DEFAULT_OVERLAP_LINES,
  DEFAULT_THRESHOLD,
} from "./engine.js";
import { discoverFiles } from "./files.js";
import { semanticRequestForCandidate } from "./semantic.js";
import type {
  Diagnostic,
  FixtureCalibrationEntry,
  JevCheckRule,
  RecallMutantResult,
  RecallRunResult,
  RuleEvidenceCheck,
  RuleEvidenceCheckStatus,
  RuleEvidencePolicy,
  RuleEvidenceReport,
} from "./types.js";

export interface CurrentFixtureEvidence {
  ruleId: string;
  path: string;
  expected: "valid" | "invalid";
  threshold: number;
  semanticKeys: string[];
  candidateCount: number;
}

export interface FixtureEvidenceSnapshot {
  fixtures: CurrentFixtureEvidence[];
  diagnostics: Diagnostic[];
}

export interface FixtureEvidenceOptions {
  cwd?: string;
  chunkChars?: number;
  overlapLines?: number;
  contextLines?: number;
}

export interface RuleDriftEvidence {
  significantMovers: string[];
  stale: string[];
  added: string[];
  removed: string[];
  fixtureFailures: string[];
  thinMargins: string[];
}

export interface RuleRobustnessEvidence {
  cases: number;
  flips: string[];
  maxProbabilityDelta: number;
}

export interface RuleEvidenceInputs {
  fixtures: readonly CurrentFixtureEvidence[];
  fixtureDiagnostics?: readonly Diagnostic[];
  calibration?: readonly FixtureCalibrationEntry[];
  calibrationError?: string;
  drift?: RuleDriftEvidence;
  driftError?: string;
  mutation?: readonly RecallMutantResult[];
  mutationError?: string;
  robustness?: RuleRobustnessEvidence;
  robustnessError?: string;
}

export const DEFAULT_RULE_EVIDENCE_POLICY: RuleEvidencePolicy = {
  requireValidFixture: true,
  requireInvalidFixture: true,
  allowThinMargins: false,
  requireCurrentCalibration: true,
  requireCleanDrift: true,
  requireMutants: true,
  minMutationRecall: 0.9,
  requireSource: true,
};


const POLICY_FIELDS = [
  "requireValidFixture",
  "requireInvalidFixture",
  "allowThinMargins",
  "requireCurrentCalibration",
  "requireCleanDrift",
  "requireMutants",
  "minMutationRecall",
  "requireSource",
] as const;

export function parseRuleEvidencePolicy(
  value: unknown,
  field = "graduation",
): Partial<RuleEvidencePolicy> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(field + " must be an object");
  }

  const policy = value as Record<string, unknown>;
  const unknown = Object.keys(policy).filter(
    (key) => !POLICY_FIELDS.includes(key as (typeof POLICY_FIELDS)[number]),
  );
  if (unknown.length) {
    throw new Error(field + " contains unknown field(s): " + unknown.join(", "));
  }

  for (const key of POLICY_FIELDS) {
    if (key === "minMutationRecall") continue;
    if (policy[key] !== undefined && typeof policy[key] !== "boolean") {
      throw new Error(field + "." + key + " must be a boolean");
    }
  }

  if (
    policy.minMutationRecall !== undefined &&
    (typeof policy.minMutationRecall !== "number" ||
      !Number.isFinite(policy.minMutationRecall) ||
      policy.minMutationRecall < 0 ||
      policy.minMutationRecall > 1)
  ) {
    throw new Error(field + ".minMutationRecall must be between 0 and 1");
  }

  return policy as Partial<RuleEvidencePolicy>;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function statusFor(required: boolean): RuleEvidenceCheckStatus {
  return required ? "block" : "warn";
}

function calibratedPass(
  fixture: CurrentFixtureEvidence,
  calibration: FixtureCalibrationEntry,
): boolean {
  return fixture.expected === "invalid"
    ? calibration.probability >= fixture.threshold
    : calibration.probability < fixture.threshold;
}

function calibratedMargin(
  fixture: CurrentFixtureEvidence,
  calibration: FixtureCalibrationEntry,
): number {
  return fixture.expected === "invalid"
    ? calibration.probability - fixture.threshold
    : fixture.threshold - calibration.probability;
}

export async function collectCurrentFixtureEvidence(
  rules: readonly JevCheckRule[],
  options: FixtureEvidenceOptions = {},
): Promise<FixtureEvidenceSnapshot> {
  const cwd = options.cwd ?? process.cwd();
  const candidateOptions = {
    chunkChars: options.chunkChars ?? DEFAULT_CHUNK_CHARS,
    overlapLines: options.overlapLines ?? DEFAULT_OVERLAP_LINES,
    contextLines: options.contextLines ?? DEFAULT_CONTEXT_LINES,
  };
  const fixtures: CurrentFixtureEvidence[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const rule of rules) {
    const groups: Array<["valid" | "invalid", string[] | undefined]> = [
      ["valid", rule.fixtures?.valid],
      ["invalid", rule.fixtures?.invalid],
    ];

    for (const [expected, patterns] of groups) {
      if (!patterns?.length) continue;
      const paths = await discoverFiles(patterns, [], cwd);
      if (!paths.length) {
        diagnostics.push({
          level: "error",
          ruleId: rule.id,
          message: "Fixture patterns for " + expected + " matched no files: " + patterns.join(", "),
        });
        continue;
      }

      for (const fixturePath of paths) {
        const path = fixturePath.replaceAll("\\", "/");
        const source = await readFile(resolve(cwd, fixturePath), "utf8");
        const built = buildCandidates(path, source, rule, candidateOptions);
        diagnostics.push(...built.diagnostics);
        const semanticKeys = [
          ...new Set(
            built.candidates.map(
              (candidate) => semanticRequestForCandidate(rule, path, candidate).identity.key,
            ),
          ),
        ].sort();

        fixtures.push({
          ruleId: rule.id,
          path,
          expected,
          threshold: rule.threshold ?? DEFAULT_THRESHOLD,
          semanticKeys,
          candidateCount: built.candidates.length,
        });
      }
    }
  }

  fixtures.sort(
    (a, b) =>
      a.ruleId.localeCompare(b.ruleId) ||
      a.expected.localeCompare(b.expected) ||
      a.path.localeCompare(b.path),
  );

  return { fixtures, diagnostics };
}

export function mutationEvidenceForRule(
  ruleId: string,
  recall: RecallRunResult,
): RecallMutantResult[] {
  return recall.mutants.filter((item) => item.ruleId === ruleId);
}

export function evaluateRuleEvidence(
  rule: JevCheckRule,
  evidence: RuleEvidenceInputs,
  policyOverrides: Partial<RuleEvidencePolicy> = {},
): RuleEvidenceReport {
  const policy = {
    ...DEFAULT_RULE_EVIDENCE_POLICY,
    ...parseRuleEvidencePolicy(policyOverrides, "rule evidence policy"),
  };
  const checks: RuleEvidenceCheck[] = [];
  const fixtures = evidence.fixtures.filter((item) => item.ruleId === rule.id);
  const valid = fixtures.filter((item) => item.expected === "valid");
  const invalid = fixtures.filter((item) => item.expected === "invalid");
  const fixtureErrors = (evidence.fixtureDiagnostics ?? []).filter(
    (item) => item.ruleId === rule.id && item.level === "error",
  );
  const noCandidates = fixtures.filter((item) => item.candidateCount === 0);

  const calibrationByKey = new Map(
    (evidence.calibration ?? []).map((entry) => [fixtureCalibrationKey(entry), entry]),
  );
  const currentByKey = new Map(
    fixtures.map((fixture) => [fixtureCalibrationKey(fixture), fixture]),
  );
  const missingCalibration: CurrentFixtureEvidence[] = [];
  const staleCalibration: Array<{
    fixture: CurrentFixtureEvidence;
    reason: "semantic-inputs" | "threshold";
  }> = [];
  const currentCalibration: Array<{
    fixture: CurrentFixtureEvidence;
    calibration: FixtureCalibrationEntry;
  }> = [];
  const semanticallyCurrentCalibration: Array<{
    fixture: CurrentFixtureEvidence;
    calibration: FixtureCalibrationEntry;
  }> = [];

  if (evidence.calibration) {
    for (const fixture of fixtures) {
      const recorded = calibrationByKey.get(fixtureCalibrationKey(fixture));
      if (!recorded) {
        missingCalibration.push(fixture);
        continue;
      }
      if (!sameStrings(recorded.semanticKeys, fixture.semanticKeys)) {
        staleCalibration.push({ fixture, reason: "semantic-inputs" });
        continue;
      }
      semanticallyCurrentCalibration.push({ fixture, calibration: recorded });
      if (recorded.threshold !== fixture.threshold) {
        staleCalibration.push({ fixture, reason: "threshold" });
        continue;
      }
      currentCalibration.push({ fixture, calibration: recorded });
    }
  }

  const failingFixtures = currentCalibration.filter(
    ({ fixture, calibration }) => !calibratedPass(fixture, calibration),
  );
  const presenceProblems: string[] = [];
  if (policy.requireValidFixture && !rule.fixtures?.valid?.length) {
    presenceProblems.push("no valid fixtures configured");
  } else if (policy.requireValidFixture && valid.length === 0) {
    presenceProblems.push("valid fixture patterns match no files");
  }
  if (policy.requireInvalidFixture && !rule.fixtures?.invalid?.length) {
    presenceProblems.push("no invalid fixtures configured");
  } else if (policy.requireInvalidFixture && invalid.length === 0) {
    presenceProblems.push("invalid fixture patterns match no files");
  }
  if (noCandidates.length) {
    presenceProblems.push(
      noCandidates.length +
        " fixture(s) produce no semantic candidates: " +
        noCandidates.map((item) => item.path).join(", "),
    );
  }
  if (fixtureErrors.length) {
    presenceProblems.push(...fixtureErrors.map((item) => item.message));
  }
  if (failingFixtures.length) {
    presenceProblems.push(
      failingFixtures.length +
        " current calibrated fixture(s) fail: " +
        failingFixtures.map(({ fixture }) => fixture.path).join(", "),
    );
  }
  if (evidence.drift?.fixtureFailures.length) {
    presenceProblems.push(
      evidence.drift.fixtureFailures.length +
        " fixture(s) fail in current drift evidence: " +
        evidence.drift.fixtureFailures.join(", "),
    );
  }

  checks.push({
    id: "fixtures",
    status: presenceProblems.length ? "block" : "pass",
    message: presenceProblems.length
      ? presenceProblems.join("; ")
      : valid.length +
        " valid + " +
        invalid.length +
        " invalid fixture(s); " +
        currentCalibration.filter(({ fixture, calibration }) => calibratedPass(fixture, calibration)).length +
        " current calibrated result(s) passing",
  });

  const calibratedThin = currentCalibration.filter(
    ({ fixture, calibration }) =>
      calibratedPass(fixture, calibration) &&
      calibratedMargin(fixture, calibration) <= FIXTURE_THIN_MARGIN,
  );
  const thinPaths = evidence.drift
    ? [...new Set(evidence.drift.thinMargins)].sort()
    : calibratedThin.map(({ fixture }) => fixture.path);
  checks.push({
    id: "thin-margins",
    status: thinPaths.length ? (policy.allowThinMargins ? "warn" : "block") : "pass",
    message: thinPaths.length
      ? thinPaths.length +
        " passing fixture(s) have thin margins: " +
        thinPaths.join(", ")
      : "0 current passing fixtures with thin margins",
  });

  const extraCalibration = (evidence.calibration ?? []).filter(
    (entry) => entry.ruleId === rule.id && !currentByKey.has(fixtureCalibrationKey(entry)),
  );
  const calibrationProblems: string[] = [];
  if (evidence.calibrationError) {
    calibrationProblems.push(evidence.calibrationError);
  } else if (!evidence.calibration) {
    calibrationProblems.push("calibration evidence is missing");
  } else {
    if (missingCalibration.length) {
      calibrationProblems.push(
        missingCalibration.length +
          " current fixture(s) missing from calibration: " +
          missingCalibration.map((item) => item.path).join(", "),
      );
    }
    if (staleCalibration.length) {
      calibrationProblems.push(
        staleCalibration.length +
          " stale calibration entr" +
          (staleCalibration.length === 1 ? "y" : "ies") +
          ": " +
          staleCalibration
            .map(({ fixture, reason }) => fixture.path + " (" + reason + ")")
            .join(", "),
      );
    }
  }
  const calibrationStatus = calibrationProblems.length
    ? statusFor(policy.requireCurrentCalibration)
    : extraCalibration.length
      ? "warn"
      : "pass";
  checks.push({
    id: "calibration",
    status: calibrationStatus,
    message: calibrationProblems.length
      ? calibrationProblems.join("; ")
      : extraCalibration.length
        ? "current for all fixtures; " +
          extraCalibration.length +
          " obsolete calibration entr" +
          (extraCalibration.length === 1 ? "y" : "ies")
        : "current for all " + fixtures.length + " fixture(s)",
  });

  const calibratedValid = semanticallyCurrentCalibration.filter(
    ({ fixture }) => fixture.expected === "valid",
  );
  const calibratedInvalid = semanticallyCurrentCalibration.filter(
    ({ fixture }) => fixture.expected === "invalid",
  );
  if (!calibratedValid.length || !calibratedInvalid.length) {
    checks.push({
      id: "threshold-separation",
      status: "warn",
      message: "need semantically current valid and invalid calibration to measure threshold separation",
    });
  } else {
    const validMax = Math.max(...calibratedValid.map(({ calibration }) => calibration.probability));
    const invalidMin = Math.min(...calibratedInvalid.map(({ calibration }) => calibration.probability));
    const separation = invalidMin - validMax;
    const threshold = rule.threshold ?? DEFAULT_THRESHOLD;
    const interval = "(" + validMax.toFixed(3) + ", " + invalidMin.toFixed(3) + "]";
    if (separation <= 0) {
      checks.push({
        id: "threshold-separation",
        status: "warn",
        message:
          "fixture probabilities overlap: valid max=" +
          validMax.toFixed(3) +
          ", invalid min=" +
          invalidMin.toFixed(3) +
          "; no threshold separates the current labelled fixtures",
      });
    } else if (threshold <= validMax || threshold > invalidMin) {
      checks.push({
        id: "threshold-separation",
        status: "warn",
        message:
          "observed separating interval " +
          interval +
          " with separation=" +
          separation.toFixed(3) +
          "; current threshold=" +
          threshold.toFixed(3) +
          " is outside it",
      });
    } else {
      checks.push({
        id: "threshold-separation",
        status: "pass",
        message:
          "observed separating interval " +
          interval +
          " with separation=" +
          separation.toFixed(3) +
          "; current threshold=" +
          threshold.toFixed(3),
      });
    }
  }

  if (evidence.driftError) {
    checks.push({
      id: "drift",
      status: statusFor(policy.requireCleanDrift),
      message: evidence.driftError,
    });
  } else if (!evidence.drift) {
    checks.push({
      id: "drift",
      status: statusFor(policy.requireCleanDrift),
      message: "no persisted/current drift evidence available",
    });
  } else {
    const driftProblems = [
      ...evidence.drift.significantMovers.map((item) => "moved: " + item),
      ...evidence.drift.stale.map((item) => "stale: " + item),
      ...evidence.drift.added.map((item) => "added: " + item),
      ...evidence.drift.removed.map((item) => "removed: " + item),
    ];
    checks.push({
      id: "drift",
      status: driftProblems.length ? statusFor(policy.requireCleanDrift) : "pass",
      message: driftProblems.length ? driftProblems.join("; ") : "clean",
    });
  }

  if (evidence.robustnessError) {
    checks.push({
      id: "robustness",
      status: "warn",
      message: evidence.robustnessError,
    });
  } else if (!evidence.robustness) {
    checks.push({
      id: "robustness",
      status: "warn",
      message: "no persisted/current robustness evidence available; run jevcheck test --robustness",
    });
  } else if (evidence.robustness.cases === 0) {
    checks.push({
      id: "robustness",
      status: "warn",
      message: "robustness evidence contains no perturbation cases",
    });
  } else if (evidence.robustness.flips.length) {
    checks.push({
      id: "robustness",
      status: "warn",
      message:
        evidence.robustness.flips.length +
        " classification flip(s) across " +
        evidence.robustness.cases +
        " perturbation case(s): " +
        evidence.robustness.flips.join(", ") +
        "; max |Δp|=" +
        evidence.robustness.maxProbabilityDelta.toFixed(3),
    });
  } else {
    checks.push({
      id: "robustness",
      status: "pass",
      message:
        "0 classification flips across " +
        evidence.robustness.cases +
        " perturbation case(s); max |Δp|=" +
        evidence.robustness.maxProbabilityDelta.toFixed(3),
    });
  }

  const configuredMutants = rule.mutants?.map((item) => item.id) ?? [];
  if (!configuredMutants.length) {
    checks.push({
      id: "mutation",
      status: statusFor(policy.requireMutants),
      message: "no mutants configured",
    });
  } else if (evidence.mutationError) {
    checks.push({
      id: "mutation",
      status: statusFor(policy.requireMutants),
      message: evidence.mutationError,
    });
  } else if (!evidence.mutation) {
    checks.push({
      id: "mutation",
      status: statusFor(policy.requireMutants),
      message: configuredMutants.length + " mutant(s) configured; no current recall evidence available",
    });
  } else {
    const byMutant = new Map(
      evidence.mutation
        .filter((item) => item.ruleId === rule.id)
        .map((item) => [item.mutantId, item]),
    );
    const missingMeasurements = configuredMutants.filter((id) => !byMutant.has(id));
    const zeroJudged = configuredMutants.filter((id) => byMutant.get(id)?.judged === 0);
    const unmeasured = configuredMutants.filter((id) => {
      const result = byMutant.get(id);
      return result !== undefined && result.judged > 0 && result.recall === undefined;
    });
    const measured = configuredMutants
      .map((id) => byMutant.get(id))
      .filter(
        (item): item is RecallMutantResult =>
          item !== undefined && item.judged > 0 && item.recall !== undefined,
      );
    const weakest = measured.length
      ? Math.min(...measured.map((item) => item.recall!))
      : undefined;
    const missPaths = measured.flatMap((item) => item.misses);
    const misses = missPaths.length;

    const mutationProblems: string[] = [];
    if (missingMeasurements.length) {
      mutationProblems.push("missing recall measurements: " + missingMeasurements.join(", "));
    }
    if (zeroJudged.length) {
      mutationProblems.push("zero judged samples: " + zeroJudged.join(", "));
    }
    if (unmeasured.length) {
      mutationProblems.push("unmeasured recall: " + unmeasured.join(", "));
    }
    if (weakest !== undefined && weakest < policy.minMutationRecall) {
      mutationProblems.push(
        "weakest recall " +
          weakest.toFixed(2) +
          " < required " +
          policy.minMutationRecall.toFixed(2),
      );
    }

    const summary =
      (weakest !== undefined
        ? "weakest recall=" +
          weakest.toFixed(2) +
          " across " +
          measured.length +
          "/" +
          configuredMutants.length +
          " mutant(s)"
        : "no measured recall") +
      "; " +
      misses +
      " miss(es)" +
      (missPaths.length ? ": " + missPaths.join(", ") : "");

    checks.push({
      id: "mutation",
      status: mutationProblems.length ? statusFor(policy.requireMutants) : "pass",
      message: mutationProblems.length
        ? mutationProblems.join("; ") + "; " + summary
        : summary,
    });
  }

  checks.push({
    id: "source",
    status: rule.source ? "pass" : statusFor(policy.requireSource),
    message: rule.source ? rule.source : "rule source/provenance is missing",
  });

  const blockers = checks.filter((check) => check.status === "block").map((check) => check.message);
  const warnings = checks.filter((check) => check.status === "warn").map((check) => check.message);

  return {
    ruleId: rule.id,
    currentStatus: rule.status ?? "shadow",
    checks,
    blockers,
    warnings,
    readyForOwned: blockers.length === 0,
  };
}
