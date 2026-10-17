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

    await writeFile(coveredPath, "it('changed', () => {});");
    const stale = await inspectAndCheck();
    expect(stale.rules[0]?.execution).toBe("semantic");
    expect(stale.rules[0]?.reason).toContain("stale");
    expect(stale.inspections).toHaveLength(1);

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
