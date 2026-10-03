import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SystemOneLikeClient, SystemOneRequest, SystemOneResponse } from "@mhingston5/jev-cli";
import { projectConditionMatches } from "../src/applicability.js";
import { currentCoverageEvidence } from "../src/coverage.js";
import { createJevCheck } from "../src/engine.js";
import {
  evaluateConfiguredRuleEvidence,
  persistCoverageEvidence,
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

    expect(await projectConditionMatches({ packageJsonHasDep: "express" }, cwd)).toBe(true);
    expect(await projectConditionMatches({ fileExists: "src/server.ts" }, cwd)).toBe(true);
    expect(await projectConditionMatches({ globMatches: "src/**/*.ts" }, cwd)).toBe(true);
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
    expect(await persistCoverageEvidence(evidenceFile, [rule], cwd)).toBe(1);

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

});
