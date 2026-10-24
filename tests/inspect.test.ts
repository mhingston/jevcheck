import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SystemOneLikeClient, SystemOneRequest, SystemOneResponse } from "@mhingston5/jev-cli";
import { createJevCheck } from "../src/engine.js";
import { evaluateConfiguredRuleEvidence, persistCoverageEvidence } from "../src/evidence-store.js";
import { formatInspectionStylish, inspectSource, inspectSources } from "../src/inspect.js";
import type { JevCheckConfig, JevCheckRule } from "../src/types.js";

class CountingClient implements SystemOneLikeClient {
  calls = 0;
  async systemOne(_request: SystemOneRequest): Promise<SystemOneResponse> {
    this.calls += 1;
    return { model: "fake-jev", answers: { violation: { type: "noul", noul: 0.1 } } };
  }
}

const input = { path: "src/example.ts", source: "const safe = 1;\nconsole.log(secret);\n" };
const rule: JevCheckRule = {
  id: "security/no-sensitive-log",
  question: "Does this logging call expose a sensitive value?",
  prefilter: "console\\.log",
  contextLines: 0,
  criteria: {
    true: "A sensitive value reaches the logging call.",
    false: "Only non-sensitive data reaches the logging call.",
  },
};

describe("semantic request inspection", () => {
  it("uses the same bounded semantic request shape without calling a provider", async () => {
    const result = await inspectSource(input, [rule], {
      chunkChars: 1000, overlapLines: 0, contextLines: 0,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.rules).toMatchObject([{
      execution: "semantic", selectorRan: true, candidateCount: 1,
    }]);
    expect(result.inspections).toHaveLength(1);
    const inspection = result.inspections[0]!;
    expect(inspection.ruleId).toBe(rule.id);
    expect(inspection.previewOnly).toBe(false);
    expect(inspection.selector).toContain("prefilter");
    expect(inspection.request.state.path).toBe("src/example.ts");
    expect(inspection.request.state.focusLineRange).toEqual([2, 2]);
    expect(inspection.request.state.code).toBe("console.log(secret);");
    expect(inspection.semanticKey).toBe(inspection.request.identity.key);
    expect(inspection.estimatedRequestChars).toBeGreaterThan(0);
    expect(result.preflight).toMatchObject({
      files: 1,
      policyPairs: { semantic: 1, covered: 0, inapplicable: 0 },
      eligibleCandidates: 1, previewOnlyCandidates: 0,
      cleanZeroCandidateSemanticPairs: 0, semanticPairsWithDiagnostics: 0,
    });
    expect(result.preflight.estimatedRequestChars).toBe(inspection.estimatedRequestChars);
  });

  it("reports file exclusion even when no semantic candidates are constructed", async () => {
    const selected = { ...rule, files: ["lib/**/*.ts"] };
    const result = await inspectSource(input, [selected]);
    expect(result.rules).toMatchObject([{
      execution: "inapplicable", selectorRan: false, candidateCount: 0,
    }]);
    expect(result.rules[0]?.reason).toContain("file");
    expect(result.inspections).toEqual([]);
    const preview = await inspectSource(input, [selected], { previewSkipped: true });
    expect(preview.inspections).toHaveLength(1);
    expect(preview.inspections[0]?.previewOnly).toBe(true);
    expect(formatInspectionStylish(preview)).toContain("NOT sent by check");
    expect(preview.preflight).toMatchObject({
      policyPairs: { semantic: 0, covered: 0, inapplicable: 1 },
      eligibleCandidates: 0, estimatedRequestChars: 0, previewOnlyCandidates: 1,
    });
  });

  it("reconciles mixed semantic matches, clean zero matches and hypothetical skipped candidates", async () => {
    const quiet = { path: "src/quiet.ts", source: "const quiet = true;\n" };
    const noMatch: JevCheckRule = { ...rule, id: "security/no-match", prefilter: "never_present" };
    const outOfScope: JevCheckRule = { ...rule, id: "security/other-scope", files: ["lib/**/*.ts"] };
    const result = await inspectSources([input, quiet], [rule, noMatch, outOfScope], {
      chunkChars: 1000, overlapLines: 0, contextLines: 0, previewSkipped: true,
    });
    expect(result.preflight).toMatchObject({
      files: 2,
      policyPairs: { semantic: 4, covered: 0, inapplicable: 2 },
      eligibleCandidates: 1, previewOnlyCandidates: 1,
      cleanZeroCandidateSemanticPairs: 3, semanticPairsWithDiagnostics: 0,
      eligibleSelectorDiagnostics: { errors: 0, warnings: 0 },
      previewSelectorDiagnostics: { errors: 0, warnings: 0 },
    });
    expect(result.preflight.eligibleCandidates).toBe(result.inspections.filter((i) => !i.previewOnly).length);
    expect(result.preflight.previewOnlyCandidates).toBe(result.inspections.filter((i) => i.previewOnly).length);
    expect(result.preflight.estimatedRequestChars).toBe(result.inspections
      .filter((i) => !i.previewOnly).reduce((sum, i) => sum + i.estimatedRequestChars, 0));
    const human = formatInspectionStylish(result);
    expect(human).toContain("at most 1 uncached judge calls");
    expect(human).toContain("1 preview only (excluded)");
    expect(human).not.toContain("exact request");
    expect(formatInspectionStylish(result, true)).toContain("hypothetical request");
  });

  it("separates incomplete selections and preview diagnostics from clean zero matches", async () => {
    const oversized = { path: "src/oversized.ts", source: "const value = " + "x".repeat(200) + ";" };
    const wholeFile: JevCheckRule = {
      id: "security/oversized", question: "Is this unsafe?", wholeFile: true,
    };
    const skipped: JevCheckRule = { ...wholeFile, id: "security/skipped", files: ["lib/**/*.ts"] };
    const result = await inspectSource(oversized, [wholeFile, skipped], {
      chunkChars: 64, previewSkipped: true,
    });
    expect(result.preflight).toMatchObject({
      files: 1,
      policyPairs: { semantic: 1, covered: 0, inapplicable: 1 },
      eligibleCandidates: 0, estimatedRequestChars: 0, previewOnlyCandidates: 0,
      cleanZeroCandidateSemanticPairs: 0, semanticPairsWithDiagnostics: 1,
      eligibleSelectorDiagnostics: { errors: 0, warnings: 1 },
      previewSelectorDiagnostics: { errors: 0, warnings: 1 },
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.rules.map((r) => r.selectorDiagnostics.length)).toEqual([1, 1]);
    expect(formatInspectionStylish(result)).toContain("preview-only diagnostics: 0 errors, 1 warnings");
  });

  it("matches enforcement for projectWhen and previews skipped candidates without judging", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-inspect-project-"));
    const selected = { ...rule, projectWhen: { fileExists: "src/missing.ts" } };
    const inspected = await inspectSource(input, [selected], { projectRoot: cwd, previewSkipped: true });
    const client = new CountingClient();
    const checked = await createJevCheck({
      client, rules: [selected], projectRoot: cwd,
    }).checkSource(input.path, input.source);
    expect(inspected.rules[0]).toMatchObject({ execution: "inapplicable", selectorRan: true });
    expect(inspected.inspections[0]).toMatchObject({ execution: "inapplicable", previewOnly: true });
    expect(checked.stats.requests).toBe(0);
    expect(client.calls).toBe(0);
  });

  it("tracks current coverage, stale fallback and the enforcement request count on one snapshot", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-inspect-coverage-"));
    await mkdir(join(cwd, "tests"), { recursive: true });
    const coveredPath = join(cwd, "tests", "security.test.ts");
    await writeFile(coveredPath, "it('covers logs', () => {});");
    const selected: JevCheckRule = {
      ...rule, coveredBy: [{ id: "logging-test", path: "tests/security.test.ts" }],
    };
    const config: JevCheckConfig = {
      rules: [selected], evidenceFile: ".jevcheck/evidence.json",
    };
    await persistCoverageEvidence(join(cwd, config.evidenceFile!), [selected], cwd, true);

    const inspectAndCheck = async () => {
      const reports = (await evaluateConfiguredRuleEvidence(config, {
        cwd, modelNamespace: "typesafe:default",
      })).reports;
      const inspected = await inspectSource(input, [selected], { ruleEvidenceReports: reports, projectRoot: cwd });
      const client = new CountingClient();
      const checked = await createJevCheck({ client, rules: [selected], ruleEvidenceReports: reports })
        .checkSource(input.path, input.source);
      expect(client.calls).toBe(inspected.inspections.filter((item) => !item.previewOnly).length);
      expect(checked.stats.requests).toBe(client.calls);
      return inspected;
    };

    const covered = await inspectAndCheck();
    expect(covered.rules[0]?.execution).toBe("covered");
    expect(covered.rules[0]?.reason).toContain("human-reviewed deterministic coverage is current");
    expect(covered.inspections).toHaveLength(0);
    expect(covered.preflight).toMatchObject({
      policyPairs: { semantic: 0, covered: 1, inapplicable: 0 },
      eligibleCandidates: 0, estimatedRequestChars: 0,
    });

    await writeFile(coveredPath, "it('changed', () => {});");
    const stale = await inspectAndCheck();
    expect(stale.rules[0]?.execution).toBe("semantic");
    expect(stale.rules[0]?.reason).toContain("stale");
    expect(stale.inspections).toHaveLength(1);
    expect(stale.preflight).toMatchObject({
      policyPairs: { semantic: 1, covered: 0, inapplicable: 0 },
      eligibleCandidates: 1, estimatedRequestChars: stale.inspections[0]!.estimatedRequestChars,
    });

    // Direct library inspection resolves persisted coverage too.
    const direct = await inspectSource(input, [selected], { config, projectRoot: cwd });
    expect(direct.rules[0]?.execution).toBe("semantic");
  });

  it("skips superseded ADRs with the same policy reports as enforcement", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-inspect-adr-"));
    await mkdir(join(cwd, "docs"), { recursive: true });
    await writeFile(join(cwd, "docs", "decision.md"),
      "---\njevcheck-adr: true\nstatus: superseded\n---\n");
    const selected = { ...rule, source: "docs/decision.md" };
    const config = { rules: [selected] };
    const reports = (await evaluateConfiguredRuleEvidence(config, {
      cwd, modelNamespace: "typesafe:default",
    })).reports;
    const inspected = await inspectSources([input], [selected], {
      ruleEvidenceReports: reports, projectRoot: cwd, previewSkipped: true,
    });
    expect(inspected.rules[0]?.execution).toBe("inapplicable");
    expect(inspected.rules[0]?.reason).toContain("superseded");
    expect(inspected.inspections[0]?.previewOnly).toBe(true);
    const checked = await createJevCheck({ rules: [selected], ruleEvidenceReports: reports })
      .checkSource(input.path, input.source);
    expect(checked.stats.requests).toBe(0);
  });
});


describe("full-scope rule health (advisory only)", () => {
  it("identifies a stale glob, but not a valid zero-candidate semantic rule", async () => {
    const stale: JevCheckRule = { ...rule, id: "stale", files: ["old/**/*.ts"] };
    const quiet: JevCheckRule = { ...rule, id: "quiet", prefilter: "missing_literal" };
    const inspected = await inspectSources([input], [stale, quiet], { fullScope: true });
    expect(inspected.scopeHealth).toMatchObject([
      { ruleId: "stale", state: "no-files-in-scope", filesInScope: 0 },
      { ruleId: "quiet", state: "applicable", filesInScope: 1 },
    ]);
    expect(inspected.preflight.cleanZeroCandidateSemanticPairs).toBe(1);
    expect(inspected.diagnostics).toMatchObject([
      { code: "no-files-in-scope", level: "warning", ruleId: "stale" },
    ]);
    expect(formatInspectionStylish(inspected)).toContain("Review file globs and repository layout");
    expect(inspected.inspections).toHaveLength(0);
  });

  it("reports every configured rule in an empty repository, but does not guess for partial API calls", async () => {
    const inspected = await inspectSources([], [rule], { fullScope: true });
    expect(inspected.scopeHealth).toMatchObject([
      { ruleId: rule.id, state: "no-files-in-scope", filesInScope: 0 },
    ]);
    expect(inspected.preflight.files).toBe(0);
    expect(inspected.diagnostics[0]?.level).toBe("warning");
    const partial = await inspectSources([], [rule]);
    expect(partial.scopeHealth).toEqual([]);
    expect(partial.diagnostics).toEqual([]);
  });

  it("classifies an unmet projectWhen dependency as inapplicable, not dormant", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-scope-applicability-"));
    const condition: JevCheckRule = {
      ...rule, id: "needs-dependency", projectWhen: { packageJsonHasDep: "missing" },
    };
    const inspected = await inspectSources([input], [condition], { fullScope: true, projectRoot: cwd });
    expect(inspected.scopeHealth).toMatchObject([
      { ruleId: "needs-dependency", state: "project-inapplicable", filesInScope: 1,
        reason: expect.stringContaining("not applicable") },
    ]);
    expect(inspected.diagnostics).toEqual([]);
  });

  it("preserves deterministic coverage and retired ADR explanations", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-scope-policy-"));
    await mkdir(join(cwd, "docs"), { recursive: true });
    await writeFile(join(cwd, "docs", "retired.md"),
      "---\njevcheck-adr: true\nstatus: superseded\n---\n");
    const covered: JevCheckRule = { ...rule, id: "covered" };
    const retired: JevCheckRule = { ...rule, id: "retired", source: "docs/retired.md" };
    const reports = (await evaluateConfiguredRuleEvidence({ rules: [retired] }, {
      cwd, modelNamespace: "typesafe:default",
    })).reports;
    const inspected = await inspectSources([input], [covered, retired], {
      projectRoot: cwd, fullScope: true,
      ruleEvidenceReports: [
        { ruleId: "covered", currentStatus: "shadow", execution: "covered",
          checks: [{ id: "coverage", status: "pass", message: "reviewed deterministic coverage" }],
          blockers: [], warnings: [], readyForOwned: true },
        ...reports,
      ],
    });
    expect(inspected.scopeHealth).toMatchObject([
      { ruleId: "covered", state: "covered", reason: "reviewed deterministic coverage" },
      { ruleId: "retired", state: "project-inapplicable",
        reason: expect.stringContaining("superseded") },
    ]);
    expect(inspected.preflight.policyPairs).toEqual({ semantic: 0, covered: 1, inapplicable: 1 });
    expect(inspected.diagnostics).toEqual([]);
  });

  it("distinguishes clean AST no-match from incomplete unsupported AST", async () => {
    const astRule: JevCheckRule = { id: "ast/nothing", question: "Violation?", ast: { kind: "call_expression" } };
    const clean = await inspectSources([{ path: "src/quiet.ts", source: "const safe = 1;" }],
      [astRule], { fullScope: true });
    expect(clean.scopeHealth[0]?.state).toBe("applicable");
    expect(clean.preflight.cleanZeroCandidateSemanticPairs).toBe(1);
    expect(clean.diagnostics).toEqual([]);
    const incomplete = await inspectSources([{ path: "src/quiet.rb", source: "safe = true" }],
      [astRule], { fullScope: true });
    expect(incomplete.scopeHealth[0]?.state).toBe("applicable");
    expect(incomplete.preflight.semanticPairsWithDiagnostics).toBe(1);
    expect(incomplete.diagnostics.some((d) => d.code === "incomplete-evaluation")).toBe(true);
    expect(incomplete.diagnostics.some((d) => d.code === "no-files-in-scope")).toBe(false);
  });
});
