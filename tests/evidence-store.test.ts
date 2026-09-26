import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCalibration, writeCalibration } from "../src/calibration.js";
import { collectCurrentFixtureEvidence } from "../src/evidence.js";
import {
  evaluateConfiguredRuleEvidence,
  mutationEvidenceIdentity,
  persistDriftEvidence,
  persistMutationEvidence,
  readRuleEvidenceArtifact,
} from "../src/evidence-store.js";
import type {
  FixtureRunResult,
  FixtureTestResult,
  JevCheckConfig,
  JevCheckRule,
  RecallRunResult,
} from "../src/types.js";

const stats = {
  filesChecked: 0,
  candidatesChecked: 0,
  requests: 0,
  cacheHits: 0,
  replayHits: 0,
  replayMisses: 0,
  inputTokens: 0,
  outputTokens: 0,
};

function rule(status: "shadow" | "owned" = "shadow"): JevCheckRule {
  return {
    id: "security/no-secret-log",
    question: "Does this code log a secret?",
    status,
    threshold: 0.8,
    source: "docs/security.md#logging",
    files: ["src/**/*.ts"],
    prefilter: "console\\.log",
    fixtures: {
      valid: ["fixtures/valid.ts"],
      invalid: ["fixtures/invalid.ts"],
    },
    mutants: [{
      id: "inject-secret",
      pattern: "/redacted/g",
      replacement: "secret",
      replaceAll: true,
    }],
  };
}

describe("persisted rule evidence", () => {
  it("rejects malformed persisted mutant measurements instead of trusting them", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-invalid-evidence-"));
    const path = join(cwd, "evidence.json");
    const baseMutant = {
      ruleId: "security/no-secret-log",
      mutantId: "inject-secret",
      candidateCount: 1,
      sampled: 1,
      judged: 1,
      caught: 1,
      recall: 1,
      misses: [],
      invalidOriginals: [],
    };

    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["negative judged", { ...baseMutant, judged: -1 }, ".judged must be a non-negative integer"],
      ["impossible caught", { ...baseMutant, caught: 2 }, ".caught must not exceed judged"],
      ["inconsistent recall", { ...baseMutant, recall: 0.5 }, ".recall must equal caught / judged"],
      ["wrong rule", { ...baseMutant, ruleId: "other" }, ".ruleId must match parent ruleId"],
    ];

    for (const [, mutant, expected] of cases) {
      await writeFile(path, JSON.stringify({
        version: 1,
        drift: [],
        mutation: [{
          ruleId: "security/no-secret-log",
          identity: "identity",
          modelNamespace: "typesafe:default",
          sampleSize: 12,
          mutants: [mutant],
        }],
      }));

      await expect(readRuleEvidenceArtifact(path)).rejects.toThrow(expected);
    }
  });

  it("rejects duplicate persisted mutant identities", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-duplicate-evidence-"));
    const path = join(cwd, "evidence.json");
    const mutant = {
      ruleId: "security/no-secret-log",
      mutantId: "inject-secret",
      candidateCount: 1,
      sampled: 1,
      judged: 1,
      caught: 1,
      recall: 1,
      misses: [],
      invalidOriginals: [],
    };
    await writeFile(path, JSON.stringify({
      version: 1,
      drift: [],
      mutation: [{
        ruleId: "security/no-secret-log",
        identity: "identity",
        modelNamespace: "typesafe:default",
        sampleSize: 12,
        mutants: [mutant, mutant],
      }],
    }));

    await expect(readRuleEvidenceArtifact(path))
      .rejects.toThrow("duplicate mutantId: inject-secret");
  });

  it("survives shadow to owned but becomes stale when sampled mutation inputs change", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-evidence-store-"));
    await mkdir(join(cwd, "fixtures"), { recursive: true });
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "fixtures", "valid.ts"), "console.log(redacted);");
    await writeFile(join(cwd, "fixtures", "invalid.ts"), "console.log(secret);");
    await writeFile(join(cwd, "src", "a.ts"), "console.log(redacted);");
    await writeFile(join(cwd, "src", "unrelated.ts"), "const value = 1;");

    const shadow = rule("shadow");
    const snapshot = await collectCurrentFixtureEvidence([shadow], { cwd });
    const tests: FixtureTestResult[] = snapshot.fixtures.map((fixture) => ({
      ruleId: fixture.ruleId,
      path: fixture.path,
      expected: fixture.expected,
      passed: true,
      maxProbability: fixture.expected === "valid" ? 0.1 : 0.95,
      threshold: fixture.threshold,
      margin: fixture.expected === "valid" ? 0.7 : 0.15,
      thinMargin: false,
      semanticKeys: fixture.semanticKeys,
      model: "fake-jev",
    }));

    const calibrationFile = join(cwd, ".jevcheck", "calibration.json");
    const evidenceFile = join(cwd, ".jevcheck", "evidence.json");
    await writeCalibration(calibrationFile, tests);
    const calibration = await readCalibration(calibrationFile);
    const fixtureRun: FixtureRunResult = { tests, diagnostics: [], stats };

    await persistDriftEvidence(
      evidenceFile,
      [shadow],
      snapshot.fixtures,
      calibration,
      fixtureRun,
      {
        compared: 2,
        meanAbsoluteDelta: 0,
        moved: [],
        stale: [],
        added: [],
        removed: [],
        driftThreshold: 0.1,
      },
      0.1,
      "typesafe:default",
    );

    const recall: RecallRunResult = {
      mutants: [{
        ruleId: shadow.id,
        mutantId: "inject-secret",
        candidateCount: 1,
        sampled: 1,
        judged: 1,
        caught: 1,
        recall: 1,
        misses: [],
        invalidOriginals: [],
      }],
      weakestRecall: 1,
      diagnostics: [],
      stats,
    };
    await persistMutationEvidence(
      evidenceFile,
      [shadow],
      recall,
      ["src/a.ts", "src/unrelated.ts"],
      12,
      {
        cwd,
        include: ["src/**/*.ts"],
        exclude: [],
        modelNamespace: "typesafe:default",
      },
    );

    const config: JevCheckConfig = {
      include: ["src/**/*.ts"],
      calibrationFile,
      evidenceFile,
      rules: [rule("owned")],
    };

    const ready = await evaluateConfiguredRuleEvidence(config, {
      cwd,
      modelNamespace: "typesafe:default",
    });
    expect(ready.reports[0]?.readyForOwned).toBe(true);

    await writeFile(join(cwd, "src", "unrelated.ts"), "const value = 2;");
    const unrelatedEdit = await evaluateConfiguredRuleEvidence(config, {
      cwd,
      modelNamespace: "typesafe:default",
    });
    expect(unrelatedEdit.reports[0]?.readyForOwned).toBe(true);

    await writeFile(join(cwd, "src", "a.ts"), "console.log(redacted); // changed");
    const stale = await evaluateConfiguredRuleEvidence(config, {
      cwd,
      modelNamespace: "typesafe:default",
    });
    expect(stale.reports[0]?.readyForOwned).toBe(false);
    expect(stale.reports[0]?.checks.find((check) => check.id === "mutation")?.message)
      .toContain("persisted mutation recall evidence is stale");
  });

  it("includes model and sample size in mutation freshness", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-mutation-identity-"));
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "a.ts"), "console.log(redacted);");
    const candidate = rule();
    const paths = ["src/a.ts"];

    const base = await mutationEvidenceIdentity(candidate, paths, {
      cwd,
      include: ["src/**/*.ts"],
      exclude: [],
      sampleSize: 12,
      modelNamespace: "typesafe:default",
    });
    const differentModel = await mutationEvidenceIdentity(candidate, paths, {
      cwd,
      include: ["src/**/*.ts"],
      exclude: [],
      sampleSize: 12,
      modelNamespace: "openrouter:jev",
    });
    const differentSample = await mutationEvidenceIdentity(candidate, paths, {
      cwd,
      include: ["src/**/*.ts"],
      exclude: [],
      sampleSize: 20,
      modelNamespace: "typesafe:default",
    });

    expect(differentModel).not.toBe(base);
    expect(differentSample).not.toBe(base);
  });
});
