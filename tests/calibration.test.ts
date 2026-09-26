import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareCalibration,
  readCalibration,
  thresholdDiagnostics,
  writeCalibration,
} from "../src/calibration.js";
import type { FixtureTestResult } from "../src/types.js";

const baseTests: FixtureTestResult[] = [
  {
    ruleId: "rule/a",
    path: "fixtures/a.ts",
    expected: "invalid",
    passed: true,
    maxProbability: 0.91,
    threshold: 0.8,
    margin: 0.11,
    thinMargin: false,
    semanticKeys: ["semantic-a"],
    model: "jev-a",
  },
  {
    ruleId: "rule/a",
    path: "fixtures/b.ts",
    expected: "valid",
    passed: true,
    maxProbability: 0.2,
    threshold: 0.8,
    margin: 0.6,
    thinMargin: false,
    semanticKeys: ["semantic-b"],
    model: "jev-a",
  },
];

describe("fixture calibration", () => {
  it("writes and reads a deterministic versioned calibration file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-calibration-"));
    const path = join(cwd, "calibration.json");

    expect(await writeCalibration(path, [...baseTests].reverse())).toBe(2);
    const recorded = await readCalibration(path);

    expect(recorded).toEqual([
      {
        ruleId: "rule/a",
        path: "fixtures/a.ts",
        expected: "invalid",
        probability: 0.91,
        threshold: 0.8,
        semanticKeys: ["semantic-a"],
        model: "jev-a",
      },
      {
        ruleId: "rule/a",
        path: "fixtures/b.ts",
        expected: "valid",
        probability: 0.2,
        threshold: 0.8,
        semanticKeys: ["semantic-b"],
        model: "jev-a",
      },
    ]);
  });

  it("reports the labelled fixture threshold separation", () => {
    const diagnostics = thresholdDiagnostics([
      {
        ruleId: "rule/a",
        path: "fixtures/valid-a.ts",
        expected: "valid",
        probability: 0.21,
        threshold: 0.8,
        semanticKeys: ["valid-a"],
      },
      {
        ruleId: "rule/a",
        path: "fixtures/valid-b.ts",
        expected: "valid",
        probability: 0.35,
        threshold: 0.8,
        semanticKeys: ["valid-b"],
      },
      {
        ruleId: "rule/a",
        path: "fixtures/invalid.ts",
        expected: "invalid",
        probability: 0.86,
        threshold: 0.8,
        semanticKeys: ["invalid"],
      },
      {
        ruleId: "rule/b",
        path: "fixtures/valid.ts",
        expected: "valid",
        probability: 0.74,
        threshold: 0.8,
        semanticKeys: ["valid"],
      },
      {
        ruleId: "rule/b",
        path: "fixtures/invalid.ts",
        expected: "invalid",
        probability: 0.69,
        threshold: 0.8,
        semanticKeys: ["invalid"],
      },
    ]);

    expect(diagnostics).toEqual([
      expect.objectContaining({
        ruleId: "rule/a",
        validMax: 0.35,
        invalidMin: 0.86,
        separation: 0.51,
        separable: true,
      }),
      expect.objectContaining({
        ruleId: "rule/b",
        validMax: 0.74,
        invalidMin: 0.69,
        separation: -0.05,
        separable: false,
      }),
    ]);
  });

  it("reports probability drift, added fixtures, and removed fixtures", () => {
    const recorded = [
      {
        ruleId: "rule/a",
        path: "fixtures/a.ts",
        expected: "invalid" as const,
        probability: 0.91,
        threshold: 0.8,
        semanticKeys: ["semantic-a"],
        model: "jev-a",
      },
      {
        ruleId: "rule/a",
        path: "fixtures/removed.ts",
        expected: "valid" as const,
        probability: 0.1,
        threshold: 0.8,
        semanticKeys: ["semantic-removed"],
        model: "jev-a",
      },
    ];
    const current: FixtureTestResult[] = [
      {
        ...baseTests[0]!,
        maxProbability: 0.7,
        passed: false,
        margin: -0.1,
        model: "jev-b",
      },
      {
        ...baseTests[1]!,
        path: "fixtures/new.ts",
      },
    ];

    const drift = compareCalibration(recorded, current);

    expect(drift.compared).toBe(1);
    expect(drift.meanAbsoluteDelta).toBeCloseTo(0.21);
    expect(drift.moved).toHaveLength(1);
    expect(drift.moved[0]).toMatchObject({
      path: "fixtures/a.ts",
      before: 0.91,
      after: 0.7,
      beforeModel: "jev-a",
      afterModel: "jev-b",
    });
    expect(drift.stale).toHaveLength(0);
    expect(drift.added.map((entry) => entry.path)).toEqual(["fixtures/new.ts"]);
    expect(drift.removed.map((entry) => entry.path)).toEqual(["fixtures/removed.ts"]);
  });

  it("marks threshold changes stale rather than model drift", () => {
    const recorded = [{
      ruleId: "rule/a",
      path: "fixtures/a.ts",
      expected: "invalid" as const,
      probability: 0.91,
      threshold: 0.8,
      semanticKeys: ["semantic-a"],
      model: "jev-a",
    }];
    const current: FixtureTestResult[] = [{
      ...baseTests[0]!,
      threshold: 0.85,
      margin: 0.06,
    }];

    const drift = compareCalibration(recorded, current);
    expect(drift.compared).toBe(0);
    expect(drift.moved).toHaveLength(0);
    expect(drift.stale[0]).toMatchObject({
      reason: "threshold",
      beforeThreshold: 0.8,
      afterThreshold: 0.85,
    });
  });

  it("does not report unchanged probabilities as movement when driftThreshold is zero", () => {
    const recorded = [{
      ruleId: "rule/a",
      path: "fixtures/a.ts",
      expected: "invalid" as const,
      probability: 0.91,
      threshold: 0.8,
      semanticKeys: ["semantic-a"],
    }];
    const drift = compareCalibration(recorded, [baseTests[0]!], 0);
    expect(drift.compared).toBe(1);
    expect(drift.moved).toHaveLength(0);
  });

  it("refuses to calibrate fixtures that produced no semantic evaluations", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-calibration-empty-"));
    await expect(writeCalibration(join(cwd, "calibration.json"), [{
      ...baseTests[0]!,
      semanticKeys: [],
    }])).rejects.toThrow("produced no semantic evaluations");
  });

  it("marks changed semantic inputs as stale rather than model drift", () => {
    const recorded = [{
      ruleId: "rule/a",
      path: "fixtures/a.ts",
      expected: "invalid" as const,
      probability: 0.91,
      threshold: 0.8,
      semanticKeys: ["old-semantic"],
      model: "jev-a",
    }];
    const current: FixtureTestResult[] = [{
      ...baseTests[0]!,
      maxProbability: 0.5,
      semanticKeys: ["new-semantic"],
    }];

    const drift = compareCalibration(recorded, current);

    expect(drift.compared).toBe(0);
    expect(drift.moved).toHaveLength(0);
    expect(drift.stale).toEqual([
      expect.objectContaining({
        path: "fixtures/a.ts",
        reason: "semantic-inputs",
        beforeSemanticKeys: ["old-semantic"],
        afterSemanticKeys: ["new-semantic"],
      }),
    ]);
  });

  it("fails clearly when drift has no recorded calibration", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-calibration-missing-"));
    await expect(readCalibration(join(cwd, "missing.json"))).rejects.toThrow(
      "run jevcheck test --record first",
    );
  });
});
