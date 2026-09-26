import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  SystemOneLikeClient,
  SystemOneRequest,
  SystemOneResponse,
} from "@mhingston5/jev-cli";
import { readCalibrationFile, writeCalibration } from "../src/calibration.js";
import { createJevCheck } from "../src/engine.js";
import { collectCurrentFixtureEvidence, evaluateRuleEvidence } from "../src/evidence.js";
import { evaluateConfiguredRuleEvidence } from "../src/evidence-store.js";
import type { FixtureCalibrationEntry, JevCheckRule } from "../src/types.js";

class FixtureClient implements SystemOneLikeClient {
  async systemOne(request: SystemOneRequest): Promise<SystemOneResponse> {
    const code = (request.state as { code: string }).code;
    return {
      model: "jev-a",
      answers: {
        violation: { type: "noul", noul: code.includes("secret") ? 0.95 : 0.05 },
      },
    };
  }
}

describe("confirmation fixtures", () => {
  it("keeps confirmation fixtures out of reusable development fixture runs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-confirmation-"));
    await mkdir(join(cwd, "fixtures", "development"), { recursive: true });
    await mkdir(join(cwd, "fixtures", "confirmation"), { recursive: true });
    await writeFile(
      join(cwd, "fixtures", "development", "invalid.ts"),
      "console.log(secret);\n",
    );
    await writeFile(
      join(cwd, "fixtures", "confirmation", "valid.ts"),
      "console.log(redacted);\n",
    );
    await writeFile(
      join(cwd, "fixtures", "confirmation", "invalid.ts"),
      "console.log(secret);\n",
    );

    const checker = createJevCheck({
      client: new FixtureClient(),
      mode: "measure",
      rules: [{
        id: "security/no-secret-log",
        question: "Does this code log a secret?",
        threshold: 0.8,
        ast: { pattern: "console.log($A)" },
        fixtures: {
          invalid: ["fixtures/development/invalid.ts"],
          confirmation: {
            valid: ["fixtures/confirmation/valid.ts"],
            invalid: ["fixtures/confirmation/invalid.ts"],
          },
        },
      }],
    });

    const development = await checker.testFixtures(cwd);
    const confirmation = await checker.testFixtures(cwd, "confirmation");

    expect(development.tests.map((item) => item.path)).toEqual([
      "fixtures/development/invalid.ts",
    ]);
    expect(confirmation.tests.map((item) => item.path).sort()).toEqual([
      "fixtures/confirmation/invalid.ts",
      "fixtures/confirmation/valid.ts",
    ]);
    expect(confirmation.tests.every((item) => item.passed)).toBe(true);
  });

  it("rejects confirmation fixtures that overlap development fixtures", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-confirmation-overlap-"));
    await mkdir(join(cwd, "fixtures"), { recursive: true });
    await writeFile(join(cwd, "fixtures", "shared.ts"), "console.log(secret);\n");
    await writeFile(join(cwd, "fixtures", "valid.ts"), "console.log(redacted);\n");

    const candidate: JevCheckRule = {
      id: "security/no-secret-log",
      question: "Does this code log a secret?",
      threshold: 0.8,
      ast: { pattern: "console.log($A)" },
      fixtures: {
        invalid: ["fixtures/shared.ts"],
        confirmation: {
          valid: ["fixtures/valid.ts"],
          invalid: ["fixtures/shared.ts"],
        },
      },
    };
    const checker = createJevCheck({
      client: new FixtureClient(),
      mode: "measure",
      rules: [candidate],
    });

    const run = await checker.testFixtures(cwd, "confirmation");
    expect(run.tests).toHaveLength(0);
    expect(run.diagnostics[0]?.level).toBe("error");
    expect(run.diagnostics[0]?.message).toContain(
      "Confirmation fixtures overlap development fixtures: fixtures/shared.ts",
    );

    const snapshot = await collectCurrentFixtureEvidence([candidate], {
      cwd,
      fixtureSet: "confirmation",
    });
    expect(snapshot.fixtures).toHaveLength(0);
    expect(snapshot.diagnostics[0]?.message).toContain(
      "Confirmation fixtures overlap development fixtures: fixtures/shared.ts",
    );
  });

  it("blocks graduation when configured confirmation evidence is missing or stale", () => {
    const rule: JevCheckRule = {
      id: "security/no-secret-log",
      question: "Does this code log a secret?",
      threshold: 0.8,
      fixtures: {
        confirmation: {
          valid: ["fixtures/confirmation/valid.ts"],
          invalid: ["fixtures/confirmation/invalid.ts"],
        },
      },
    };
    const confirmationFixtures = [
      {
        ruleId: rule.id,
        path: "fixtures/confirmation/valid.ts",
        expected: "valid" as const,
        threshold: 0.8,
        semanticKeys: ["valid-key"],
        candidateCount: 1,
      },
      {
        ruleId: rule.id,
        path: "fixtures/confirmation/invalid.ts",
        expected: "invalid" as const,
        threshold: 0.8,
        semanticKeys: ["invalid-key"],
        candidateCount: 1,
      },
    ];
    const passing: FixtureCalibrationEntry[] = [
      {
        ruleId: rule.id,
        path: "fixtures/confirmation/valid.ts",
        expected: "valid",
        probability: 0.05,
        threshold: 0.8,
        semanticKeys: ["valid-key"],
        model: "jev-a",
      },
      {
        ruleId: rule.id,
        path: "fixtures/confirmation/invalid.ts",
        expected: "invalid",
        probability: 0.95,
        threshold: 0.8,
        semanticKeys: ["invalid-key"],
        model: "jev-a",
      },
    ];
    const policy = {
      requireValidFixture: false,
      requireInvalidFixture: false,
      requireCurrentCalibration: false,
      requireCleanDrift: false,
      requireMutants: false,
      requireSource: false,
    };

    const missing = evaluateRuleEvidence(
      rule,
      { fixtures: [], confirmationFixtures },
      policy,
    );
    expect(missing.checks.find((item) => item.id === "confirmation")?.status)
      .toBe("block");
    expect(missing.checks.find((item) => item.id === "confirmation")?.message)
      .toContain("confirmation evidence is missing");

    const current = evaluateRuleEvidence(
      rule,
      { fixtures: [], confirmationFixtures, confirmation: passing },
      policy,
    );
    expect(current.checks.find((item) => item.id === "confirmation")?.status)
      .toBe("pass");

    const stale = evaluateRuleEvidence(
      rule,
      {
        fixtures: [],
        confirmationFixtures,
        confirmation: [{ ...passing[0]!, semanticKeys: ["old-key"] }, passing[1]!],
      },
      policy,
    );
    expect(stale.checks.find((item) => item.id === "confirmation")?.status)
      .toBe("block");
    expect(stale.checks.find((item) => item.id === "confirmation")?.message)
      .toContain("stale confirmation");

    const obsolete = evaluateRuleEvidence(
      rule,
      {
        fixtures: [],
        confirmationFixtures,
        confirmation: [
          ...passing,
          {
            ...passing[0]!,
            path: "fixtures/confirmation/removed.ts",
            semanticKeys: ["removed-key"],
          },
        ],
      },
      policy,
    );
    expect(obsolete.checks.find((item) => item.id === "confirmation")?.status)
      .toBe("block");
    expect(obsolete.checks.find((item) => item.id === "confirmation")?.message)
      .toContain("obsolete confirmation entry");
  });

  it("invalidates recorded confirmation when the configured model namespace changes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-confirmation-model-"));
    await mkdir(join(cwd, "fixtures", "confirmation"), { recursive: true });
    await writeFile(
      join(cwd, "fixtures", "confirmation", "valid.ts"),
      "console.log(redacted);\n",
    );
    await writeFile(
      join(cwd, "fixtures", "confirmation", "invalid.ts"),
      "console.log(secret);\n",
    );

    const candidate: JevCheckRule = {
      id: "security/no-secret-log",
      question: "Does this code log a secret?",
      threshold: 0.8,
      ast: { pattern: "console.log($A)" },
      fixtures: {
        confirmation: {
          valid: ["fixtures/confirmation/valid.ts"],
          invalid: ["fixtures/confirmation/invalid.ts"],
        },
      },
    };
    const checker = createJevCheck({
      client: new FixtureClient(),
      mode: "measure",
      rules: [candidate],
    });
    const run = await checker.testFixtures(cwd, "confirmation");
    const confirmationFile = join(cwd, ".jevcheck", "confirmation.json");
    await writeCalibration(confirmationFile, run.tests, "typesafe:model-a");

    const artifact = await readCalibrationFile(confirmationFile, "confirmation");
    expect(artifact.modelNamespace).toBe("typesafe:model-a");

    const result = await evaluateConfiguredRuleEvidence(
      {
        confirmationFile,
        rules: [candidate],
        graduation: {
          requireValidFixture: false,
          requireInvalidFixture: false,
          requireCurrentCalibration: false,
          requireCleanDrift: false,
          requireMutants: false,
          requireSource: false,
        },
      },
      { cwd, modelNamespace: "typesafe:model-b" },
    );
    const confirmation = result.reports[0]?.checks.find(
      (item) => item.id === "confirmation",
    );
    expect(confirmation?.status).toBe("block");
    expect(confirmation?.message).toContain(
      "confirmation evidence model changed from typesafe:model-a to typesafe:model-b",
    );
  });
});
