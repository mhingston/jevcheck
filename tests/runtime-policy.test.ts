import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SystemOneLikeClient, SystemOneRequest, SystemOneResponse } from "@mhingston5/jev-cli";
import { projectConditionMatches } from "../src/applicability.js";
import { currentCoverageEvidence } from "../src/coverage.js";
import { createJevCheck } from "../src/engine.js";
import {
  evaluateConfiguredRuleEvidence,
  persistCoverageEvidence,
  persistCoverageCheckResult,
  readRuleEvidenceArtifact,
} from "../src/evidence-store.js";
import type { JevCheckRule } from "../src/types.js";

class CountingClient implements SystemOneLikeClient {
  calls = 0;

  async systemOne(_request: SystemOneRequest): Promise<SystemOneResponse> {
    this.calls += 1;
    return {
      model: "fake-jev",
      answers: { violation: { type: "noul", noul: 0.1 } },
    };
  }
}

describe("deterministic runtime policy", () => {
  it("evaluates project applicability without a model call", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-applicability-"));
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ dependencies: { express: "^5.0.0" } }),
    );
    await writeFile(join(cwd, "src", "server.ts"), "export const app = true;");
    await mkdir(join(cwd, "dist"), { recursive: true });
    await writeFile(join(cwd, "dist", "generated.js"), "export const generated = true;");

    expect(await projectConditionMatches({ packageJsonHasDep: "express" }, cwd)).toBe(true);
    expect(await projectConditionMatches({ packageJsonHasDep: "constructor" }, cwd)).toBe(false);
    expect(await projectConditionMatches({ fileExists: "src/server.ts" }, cwd)).toBe(true);
    expect(await projectConditionMatches({ globMatches: "src/**/*.ts" }, cwd)).toBe(true);
    expect(await projectConditionMatches({ globMatches: "dist/**/*.js" }, cwd)).toBe(true);
    expect(await projectConditionMatches({
      allOf: [
        { packageJsonHasDep: "express" },
        { not: { fileExists: "src/missing.ts" } },
      ],
    }, cwd)).toBe(true);
  });

  it("skips inapplicable rules during enforcement but not measurement", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-project-skip-"));
    const client = new CountingClient();
    const rule: JevCheckRule = {
      id: "express/semantic",
      question: "Is this a violation?",
      projectWhen: { packageJsonHasDep: "express" },
      wholeFile: true,
    };

    const enforce = createJevCheck({
      client,
      rules: [rule],
      mode: "enforce",
      projectRoot: cwd,
    });
    await enforce.checkSource("src/a.ts", "const value = 1;");
    expect(client.calls).toBe(0);

    const measure = createJevCheck({
      client,
      rules: [rule],
      mode: "measure",
      projectRoot: cwd,
    });
    await measure.checkSource("src/a.ts", "const value = 1;");
    expect(client.calls).toBe(1);
  });

  it("records coverage fingerprints and falls back when they become stale", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-coverage-"));
    await mkdir(join(cwd, "tests"), { recursive: true });
    await writeFile(join(cwd, "tests", "security.test.ts"), "it('blocks secrets', () => {});");

    const rule: JevCheckRule = {
      id: "security/no-secret-log",
      question: "Does this code log a secret?",
      coveredBy: [{ id: "security-test", path: "tests/security.test.ts" }],
    };
    const first = await currentCoverageEvidence(rule, cwd);
    expect(first?.links).toHaveLength(1);

    const evidenceFile = join(cwd, ".jevcheck", "evidence.json");
    expect(await persistCoverageEvidence(evidenceFile, [rule], cwd, true)).toBe(1);

    const covered = await evaluateConfiguredRuleEvidence(
      {
        evidenceFile,
        graduation: {
          requireValidFixture: false,
          requireInvalidFixture: false,
          requireCurrentCalibration: false,
          requireCleanDrift: false,
          requireMutants: false,
          requireSource: false,
        },
        rules: [rule],
      },
      { cwd, modelNamespace: "typesafe:default" },
    );
    expect(covered.reports[0]?.execution).toBe("covered");
    expect(covered.reports[0]?.readyForOwned).toBe(true);

    await writeFile(join(cwd, "tests", "security.test.ts"), "it('changed coverage', () => {});");
    const stale = await evaluateConfiguredRuleEvidence(
      {
        evidenceFile,
        graduation: {
          requireValidFixture: false,
          requireInvalidFixture: false,
          requireCurrentCalibration: false,
          requireCleanDrift: false,
          requireMutants: false,
          requireSource: false,
        },
        rules: [rule],
      },
      { cwd, modelNamespace: "typesafe:default" },
    );
    expect(stale.reports[0]?.execution).toBe("semantic");
    expect(stale.reports[0]?.checks.find((check) => check.id === "coverage")?.status).toBe("warn");
    expect(stale.reports[0]?.checks.find((check) => check.id === "coverage")?.message)
      .toContain("semantic fallback active");
  });

  it("skips the semantic judge when current coverage is supplied to enforcement", async () => {
    const client = new CountingClient();
    const checker = createJevCheck({
      client,
      rules: [{ id: "covered", question: "Is this a violation?", wholeFile: true }],
      mode: "enforce",
      ruleEvidenceReports: [{
        ruleId: "covered",
        currentStatus: "shadow",
        execution: "covered",
        checks: [],
        blockers: [],
        warnings: [],
        readyForOwned: true,
      }],
    });

    const result = await checker.checkSource("src/a.ts", "const value = 1;");
    expect(client.calls).toBe(0);
    expect(result.stats.requests).toBe(0);
  });
  it("allows fully covered enforcement without constructing a provider client", async () => {
    const checker = createJevCheck({
      rules: [{ id: "covered-no-client", question: "Is this a violation?", wholeFile: true }],
      mode: "enforce",
      ruleEvidenceReports: [{
        ruleId: "covered-no-client",
        currentStatus: "shadow",
        execution: "covered",
        checks: [],
        blockers: [],
        warnings: [],
        readyForOwned: true,
      }],
    });

    const result = await checker.checkSource("src/a.ts", "const value = 1;");
    expect(result.stats.requests).toBe(0);
    expect(result.evaluations).toHaveLength(0);
  });

  it("treats a non-matching project condition as inapplicable before semantic evidence gates", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-inapplicable-audit-"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ dependencies: {} }));

    const evaluated = await evaluateConfiguredRuleEvidence(
      {
        rules: [{
          id: "express/owned-rule",
          question: "Is this a violation?",
          status: "owned",
          projectWhen: { packageJsonHasDep: "express" },
        }],
      },
      { cwd, modelNamespace: "typesafe:default" },
    );

    expect(evaluated.reports[0]?.execution).toBe("inapplicable");
    expect(evaluated.reports[0]?.readyForOwned).toBe(true);
    expect(evaluated.reports[0]?.checks).toEqual([
      expect.objectContaining({
        id: "applicability",
        status: "pass",
        message: expect.stringContaining("not applicable"),
      }),
    ]);
  });

  it("invalidates recorded coverage when semantic rule meaning or scope changes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-coverage-semantics-"));
    await mkdir(join(cwd, "tests"), { recursive: true });
    await writeFile(join(cwd, "tests", "security.test.ts"), "it('covers logging', () => {});");

    const base: JevCheckRule = {
      id: "security/no-secret-log",
      question: "Does this code log a secret?",
      files: ["src/**/*.ts"],
      coveredBy: [{ id: "security-test", path: "tests/security.test.ts" }],
    };
    const evidenceFile = join(cwd, ".jevcheck", "evidence.json");
    await persistCoverageEvidence(evidenceFile, [base], cwd);

    for (const changed of [
      { ...base, question: "Does this code expose a credential in logs?" },
      { ...base, criteria: { true: "A credential value reaches the log call." } },
      { ...base, files: ["lib/**/*.ts"] },
    ]) {
      const evaluated = await evaluateConfiguredRuleEvidence(
        {
          evidenceFile,
          graduation: {
            requireValidFixture: false,
            requireInvalidFixture: false,
            requireCurrentCalibration: false,
            requireCleanDrift: false,
            requireMutants: false,
            requireSource: false,
          },
          rules: [changed],
        },
        { cwd, modelNamespace: "typesafe:default" },
      );
      expect(evaluated.reports[0]?.execution).toBe("semantic");
      expect(evaluated.reports[0]?.checks.find((check) => check.id === "coverage")?.message)
        .toContain("stale");
    }
  });

  it("requires a semantic client in measurement mode even when reports say covered", () => {
    expect(() =>
      createJevCheck({
        rules: [{ id: "covered-measure", question: "Is this a violation?", wholeFile: true }],
        mode: "measure",
        ruleEvidenceReports: [{
          ruleId: "covered-measure",
          currentStatus: "shadow",
          execution: "covered",
          checks: [],
          blockers: [],
          warnings: [],
          readyForOwned: true,
        }],
      }),
    ).toThrow("a Jev client is required");
  });

});

describe("reviewed coverage and CI execution evidence", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function fixture() {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-ci-coverage-"));
    await mkdir(join(cwd, "tests"), { recursive: true });
    await writeFile(join(cwd, "tests", "checks.test.ts"), "it('guards the invariant', () => {});");
    await writeFile(join(cwd, "tests", "lint.config.js"), "export const rule = true;");
    const rule: JevCheckRule = {
      id: "guard/no-bypass",
      question: "Is the guard bypassed?",
      status: "owned",
      wholeFile: true,
      coveredBy: [
        { id: "tests", path: "tests/checks.test.ts" },
        { id: "lint", path: "tests/lint.config.js" },
      ],
    };
    const evidenceFile = join(cwd, ".jevcheck", "evidence.json");
    const config = {
      evidenceFile,
      graduation: {
        requireValidFixture: false,
        requireInvalidFixture: false,
        requireCurrentCalibration: false,
        requireCleanDrift: false,
        requireMutants: false,
        requireSource: false,
      },
      rules: [rule],
    };
    const evaluate = async () => (await evaluateConfiguredRuleEvidence(
      config, { cwd, modelNamespace: "typesafe:default" },
    )).reports[0]!;
    return { cwd, rule, evidenceFile, evaluate };
  }

  function githubRun(cwd: string) {
    execFileSync("git", ["init", "--quiet"], { cwd });
    execFileSync("git", ["-c", "user.name=CI", "-c", "user.email=ci@example.test",
      "commit", "--allow-empty", "--quiet", "-m", "init"], { cwd });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_SHA", sha);
    vi.stubEnv("GITHUB_RUN_ID", "771");
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
    vi.stubEnv("GITHUB_JOB", "guard-checks");
  }

  it("treats plain fingerprints as recorded only, not permission to skip owned or shadow rules", async () => {
    const { cwd, rule, evidenceFile, evaluate } = await fixture();
    await persistCoverageEvidence(evidenceFile, [rule], cwd);
    const recorded = await evaluate();
    expect(recorded.execution).toBe("semantic");
    expect(recorded.checks.find((check) => check.id === "coverage")).toMatchObject({
      status: "warn", message: expect.stringContaining("not been explicitly reviewed"),
    });

    githubRun(cwd);
    await expect(persistCoverageCheckResult(evidenceFile, [rule], "tests", "passed", cwd))
      .rejects.toThrow("explicitly reviewed");

    // Existing v1 coverage artifacts without review metadata stay readable and non-authoritative.
    expect((await readRuleEvidenceArtifact(evidenceFile)).coverage[0]?.reviewed).toBeUndefined();
  });

  it("lets a shadow rule use reviewed fingerprints without pretending a CI pass", async () => {
    const { cwd, rule, evidenceFile } = await fixture();
    const shadow: JevCheckRule = { ...rule, status: "shadow" };
    await persistCoverageEvidence(evidenceFile, [shadow], cwd, true);
    const evaluated = await evaluateConfiguredRuleEvidence(
      { evidenceFile, rules: [shadow] }, { cwd, modelNamespace: "typesafe:default" },
    );
    expect(evaluated.reports[0]?.execution).toBe("covered");
    expect(evaluated.reports[0]?.checks.find((check) => check.id === "coverage")?.message)
      .toContain("CI execution not verified");
  });

  it("requires every linked check to pass in the same CI run and checkout for owned skips", async () => {
    const { cwd, rule, evidenceFile, evaluate } = await fixture();
    await persistCoverageEvidence(evidenceFile, [rule], cwd, true);
    expect((await evaluate()).execution).toBe("semantic");
    expect((await evaluate()).checks.find((check) => check.id === "coverage")?.message)
      .toContain("passing CI execution evidence is missing");
    await expect(persistCoverageCheckResult(evidenceFile, [rule], "tests", "passed", cwd))
      .rejects.toThrow("requires GitHub Actions");

    githubRun(cwd);
    await persistCoverageCheckResult(evidenceFile, [rule], "tests", "failed", cwd);
    const failed = await evaluate();
    expect(failed.execution).toBe("semantic");
    expect(failed.readyForOwned).toBe(false);
    expect(failed.checks.find((check) => check.id === "coverage")?.status).toBe("block");

    await persistCoverageCheckResult(evidenceFile, [rule], "tests", "passed", cwd);
    expect((await evaluate()).execution).toBe("semantic"); // lint is still missing
    await persistCoverageCheckResult(evidenceFile, [rule], "lint", "passed", cwd);
    const covered = await evaluate();
    expect(covered.execution).toBe("covered");
    expect(covered.readyForOwned).toBe(true);
    const checker = createJevCheck({
      rules: [rule], ruleEvidenceReports: [covered], mode: "enforce",
    });
    expect((await checker.checkSource("src/a.ts", "const x = 1;")).stats.requests).toBe(0);

    vi.stubEnv("GITHUB_RUN_ATTEMPT", "2");
    expect((await evaluate()).execution).toBe("semantic");
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
    vi.stubEnv("GITHUB_SHA", "0".repeat(40));
    expect((await evaluate()).execution).toBe("semantic");
    vi.stubEnv("GITHUB_SHA", execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim());
    expect((await evaluate()).execution).toBe("covered");

    await writeFile(join(cwd, "tests", "checks.test.ts"), "it('changed', () => {});");
    expect((await evaluate()).execution).toBe("semantic");
    await expect(persistCoverageCheckResult(evidenceFile, [rule], "tests", "passed", cwd))
      .rejects.toThrow("current, explicitly reviewed coverage");
  });

  it("resets verification when re-recording and never accepts unknown check ids", async () => {
    const { cwd, rule, evidenceFile, evaluate } = await fixture();
    githubRun(cwd);
    await persistCoverageEvidence(evidenceFile, [rule], cwd, true);
    await expect(persistCoverageCheckResult(evidenceFile, [rule], "typo", "passed", cwd))
      .rejects.toThrow("unknown coveredBy check id");
    await persistCoverageCheckResult(evidenceFile, [rule], "tests", "passed", cwd);
    await persistCoverageCheckResult(evidenceFile, [rule], "lint", "passed", cwd);
    expect((await evaluate()).execution).toBe("covered");
    await persistCoverageEvidence(evidenceFile, [rule], cwd, true);
    expect((await evaluate()).execution).toBe("semantic");
    expect((await readRuleEvidenceArtifact(evidenceFile)).coverage[0]?.verification).toBeUndefined();
  });
});
