import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectCurrentFixtureEvidence,
  evaluateRuleEvidence,
} from "../src/evidence.js";
import type {
  FixtureCalibrationEntry,
  JevCheckRule,
  RecallMutantResult,
} from "../src/types.js";

const rule: JevCheckRule = {
  id: "security/no-secret-log",
  question: "Does this code log a secret?",
  status: "shadow",
  threshold: 0.8,
  source: "docs/security.md#logging",
  fixtures: {
    valid: ["fixtures/valid/**/*.ts"],
    invalid: ["fixtures/invalid/**/*.ts"],
  },
  mutants: [{
    id: "inject-secret",
    pattern: "/redacted/g",
    replacement: "secret",
    replaceAll: true,
  }],
};

function currentFixture(
  path: string,
  expected: "valid" | "invalid",
  semanticKey: string,
) {
  return {
    ruleId: rule.id,
    path,
    expected,
    threshold: 0.8,
    semanticKeys: [semanticKey],
    candidateCount: 1,
  };
}

function calibration(
  path: string,
  expected: "valid" | "invalid",
  semanticKey: string,
  probability: number,
  threshold = 0.8,
): FixtureCalibrationEntry {
  return {
    ruleId: rule.id,
    path,
    expected,
    probability,
    threshold,
    semanticKeys: [semanticKey],
    model: "jev",
  };
}

function mutation(recall: number, judged = 10): RecallMutantResult {
  return {
    ruleId: rule.id,
    mutantId: "inject-secret",
    candidateCount: judged,
    sampled: judged,
    judged,
    caught: Math.round(recall * judged),
    recall,
    misses: recall < 1 ? ["src/miss.ts"] : [],
    invalidOriginals: [],
  };
}

describe("rule evidence", () => {
  it("reports a fully evidenced rule as ready for owned", () => {
    const fixtures = [
      currentFixture("fixtures/valid/a.ts", "valid", "valid-key"),
      currentFixture("fixtures/invalid/a.ts", "invalid", "invalid-key"),
    ];
    const report = evaluateRuleEvidence(rule, {
      fixtures,
      calibration: [
        calibration("fixtures/valid/a.ts", "valid", "valid-key", 0.1),
        calibration("fixtures/invalid/a.ts", "invalid", "invalid-key", 0.95),
      ],
      drift: { significantMovers: [], stale: [], added: [], removed: [] },
      mutation: [mutation(1)],
    });

    expect(report.readyForOwned).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
  });

  it("distinguishes missing evidence", () => {
    const report = evaluateRuleEvidence(
      { id: "example", question: "Is this a violation?" },
      { fixtures: [] },
    );

    expect(report.readyForOwned).toBe(false);
    expect(report.checks.find((check) => check.id === "fixtures")?.message)
      .toContain("no valid fixtures configured");
    expect(report.checks.find((check) => check.id === "calibration")?.message)
      .toContain("calibration evidence is missing");
    expect(report.checks.find((check) => check.id === "drift")?.message)
      .toContain("no persisted/current drift evidence");
    expect(report.checks.find((check) => check.id === "mutation")?.message)
      .toContain("no mutants configured");
    expect(report.checks.find((check) => check.id === "source")?.message)
      .toContain("missing");
  });

  it("separates stale calibration from missing calibration", () => {
    const fixtures = [
      currentFixture("fixtures/valid/a.ts", "valid", "new-valid-key"),
      currentFixture("fixtures/invalid/a.ts", "invalid", "invalid-key"),
    ];
    const report = evaluateRuleEvidence(rule, {
      fixtures,
      calibration: [
        calibration("fixtures/valid/a.ts", "valid", "old-valid-key", 0.1),
        calibration("fixtures/invalid/a.ts", "invalid", "invalid-key", 0.95, 0.75),
      ],
      drift: { significantMovers: [], stale: [], added: [], removed: [] },
      mutation: [mutation(1)],
    });

    const check = report.checks.find((item) => item.id === "calibration");
    expect(check?.status).toBe("block");
    expect(check?.message).toContain("2 stale calibration entries");
    expect(check?.message).toContain("semantic-inputs");
    expect(check?.message).toContain("threshold");
    expect(check?.message).not.toContain("missing from calibration");
  });

  it("reports failing fixtures, thin margins, drift and weak mutation recall independently", () => {
    const fixtures = [
      currentFixture("fixtures/valid/a.ts", "valid", "valid-key"),
      currentFixture("fixtures/invalid/a.ts", "invalid", "invalid-key"),
    ];
    const report = evaluateRuleEvidence(rule, {
      fixtures,
      calibration: [
        calibration("fixtures/valid/a.ts", "valid", "valid-key", 0.9),
        calibration("fixtures/invalid/a.ts", "invalid", "invalid-key", 0.81),
      ],
      drift: {
        significantMovers: ["fixtures/invalid/a.ts"],
        stale: [],
        added: [],
        removed: [],
      },
      mutation: [mutation(0.5)],
    });

    expect(report.checks.find((check) => check.id === "fixtures")?.status).toBe("block");
    expect(report.checks.find((check) => check.id === "thin-margins")?.status).toBe("block");
    expect(report.checks.find((check) => check.id === "drift")?.status).toBe("block");
    expect(report.checks.find((check) => check.id === "mutation")?.message)
      .toContain("0.50 < required 0.90");
  });

  it("recomputes fixture semantic identity without calling a provider", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-evidence-"));
    await mkdir(join(cwd, "fixtures"), { recursive: true });
    await writeFile(join(cwd, "fixtures", "a.ts"), "console.log(secret);");

    const base: JevCheckRule = {
      id: "identity",
      question: "Does this code log a secret?",
      prefilter: "console\\.log",
      fixtures: { invalid: ["fixtures/*.ts"] },
    };
    const first = await collectCurrentFixtureEvidence([base], { cwd });
    const second = await collectCurrentFixtureEvidence(
      [{ ...base, question: "Does this code expose a secret in a log?" }],
      { cwd },
    );

    expect(first.fixtures).toHaveLength(1);
    expect(first.fixtures[0]?.semanticKeys).toHaveLength(1);
    expect(first.fixtures[0]?.semanticKeys).not.toEqual(second.fixtures[0]?.semanticKeys);
  });
});
