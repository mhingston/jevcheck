import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  SystemOneLikeClient,
  SystemOneRequest,
  SystemOneResponse,
} from "@mhingston5/jev-cli";
import { createJevCheck } from "../src/engine.js";
import { evaluateRuleEvidence } from "../src/evidence.js";
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
  });
});
