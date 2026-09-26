import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SystemOneLikeClient, SystemOneRequest, SystemOneResponse } from "@mhingston5/jev-cli";
import { MemoryAnswerCache } from "../src/cache.js";
import { createJevCheck } from "../src/engine.js";

class FakeClient implements SystemOneLikeClient {
  calls = 0;
  states: unknown[] = [];

  async systemOne(request: SystemOneRequest): Promise<SystemOneResponse> {
    this.calls += 1;
    this.states.push(request.state);
    const state = request.state as {
      code: string;
      lineRange: [number, number];
      focusLineRange: [number, number];
    };
    const focusOffset = state.focusLineRange[0] - state.lineRange[0];
    const focusLength = state.focusLineRange[1] - state.focusLineRange[0] + 1;
    const focus = state.code.split(/\r?\n/).slice(focusOffset, focusOffset + focusLength).join("\n");
    const probability = focus.includes("console.log(secret)") ? 0.95 : 0.05;
    return {
      model: "fake-jev",
      answers: {
        violation: { type: "noul", noul: probability },
      },
      usage: { input_tokens: 10, output_tokens: 1 },
    };
  }
}

function readyEvidence(ruleId: string) {
  return [{
    ruleId,
    currentStatus: "owned" as const,
    checks: [],
    blockers: [],
    warnings: [],
    readyForOwned: true,
  }];
}

const astRule = {
  id: "security/no-secret-log",
  question: "Does this code log a secret?",
  status: "owned" as const,
  severity: "error" as const,
  threshold: 0.8,
  ast: {
    pattern: "console.log($A)",
    contextBefore: 1,
    contextAfter: 1,
  },
};

describe("createJevCheck", () => {
  it("fails closed when an owned rule has no evidence report", () => {
    expect(() =>
      createJevCheck({
        client: new FakeClient(),
        rules: [{
          id: "owned-without-evidence",
          question: "Is this a violation?",
          status: "owned",
        }],
      }),
    ).toThrow("Rule owned-without-evidence cannot be owned");
  });

  it("fails closed with the evaluator blockers", () => {
    expect(() =>
      createJevCheck({
        client: new FakeClient(),
        rules: [{
          id: "owned-blocked",
          question: "Is this a violation?",
          status: "owned",
        }],
        ruleEvidenceReports: [{
          ruleId: "owned-blocked",
          currentStatus: "owned",
          checks: [],
          blockers: ["mutation recall 0.80 < required 0.90"],
          warnings: [],
          readyForOwned: false,
        }],
      }),
    ).toThrow("mutation recall 0.80 < required 0.90");
  });

  it("keeps owned status non-blocking in explicit measurement mode", async () => {
    const checker = createJevCheck({
      client: new FakeClient(),
      mode: "measure",
      rules: [{
        id: "measurement",
        question: "Does this code log a secret?",
        status: "owned",
        threshold: 0.8,
        prefilter: "console\\.log",
      }],
    });

    const result = await checker.checkSource("src/a.ts", "console.log(secret);");
    expect(result.findings[0]).toMatchObject({ status: "owned", blocking: false });
  });

  it("uses deterministic prefilters before Jev and marks owned errors as blocking", async () => {
    const client = new FakeClient();
    const checker = createJevCheck({
      client,
      rules: [{
        id: "security/no-secret-log",
        question: "Does this code log a secret?",
        status: "owned",
        severity: "error",
        files: ["**/*.ts"],
        prefilter: "console\\.log",
        threshold: 0.8,
      }],
      ruleEvidenceReports: readyEvidence("security/no-secret-log"),
    });

    const clean = await checker.checkSource("src/a.ts", "const value = 1;");
    expect(client.calls).toBe(0);
    expect(clean.findings).toHaveLength(0);

    const unsafe = await checker.checkSource("src/a.ts", "console.log(secret);");
    expect(client.calls).toBe(1);
    expect(unsafe.findings).toHaveLength(1);
    expect(unsafe.findings[0]?.blocking).toBe(true);
  });

  it("replays identical semantic decisions from cache", async () => {
    const client = new FakeClient();
    const checker = createJevCheck({
      client,
      cache: new MemoryAnswerCache(),
      cacheNamespace: "test",
      rules: [{
        id: "security/no-secret-log",
        question: "Does this code log a secret?",
        status: "shadow",
        prefilter: "console\\.log",
      }],
    });

    const source = "console.log(secret);";
    const first = await checker.checkSource("src/a.ts", source);
    const second = await checker.checkSource("src/a.ts", source);

    expect(client.calls).toBe(1);
    expect(first.findings[0]?.blocking).toBe(false);
    expect(second.stats.cacheHits).toBe(1);
    expect(second.evaluations[0]?.cached).toBe(true);
  });

  it("treats overlap as context so one violation is not reported from two focus ranges", async () => {
    const client = new FakeClient();
    const checker = createJevCheck({
      client,
      chunkChars: 40,
      overlapLines: 1,
      rules: [{
        id: "security/no-secret-log",
        question: "Does this code log a secret?",
        status: "owned",
        threshold: 0.8,
      }],
      ruleEvidenceReports: readyEvidence("security/no-secret-log"),
    });

    const source = [
      "aaaaaaaaaaaaaaa",
      "console.log(secret);",
      "bbbbbbbbbbbbbbb",
      "ccccccccccccccc",
    ].join("\n");
    const result = await checker.checkSource("src/a.ts", source);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ startLine: 1, endLine: 2 });
  });

  it("passes exact AST focus metadata to Jev and the result", async () => {
    const client = new FakeClient();
    const checker = createJevCheck({ client, rules: [astRule], ruleEvidenceReports: readyEvidence(astRule.id) });
    const result = await checker.checkSource("src/a.ts", "const x = 1; console.log(secret);");

    expect(result.findings[0]).toMatchObject({
      startLine: 1,
      startColumn: 14,
      focusKind: "call_expression",
    });
    expect(client.states[0]).toMatchObject({
      focusRange: {
        start: { line: 1, column: 14 },
      },
      focusKind: "call_expression",
    });
  });

  it("suppresses an AST finding only when an inline comment includes a reason", async () => {
    const source = [
      "// jevcheck-ignore security/no-secret-log -- value is redacted by the logger wrapper",
      "console.log(secret);",
    ].join("\n");
    const checker = createJevCheck({ client: new FakeClient(), rules: [astRule], ruleEvidenceReports: readyEvidence(astRule.id) });

    const result = await checker.checkSource("src/a.ts", source);

    expect(result.findings).toHaveLength(0);
    expect(result.suppressedFindings).toHaveLength(1);
    expect(result.suppressedFindings[0]).toMatchObject({
      suppression: "inline",
      suppressionReason: "value is redacted by the logger wrapper",
    });
  });

  it("suppresses an unchanged finding when its fingerprint is in the baseline", async () => {
    const source = "console.log(secret);";
    const first = await createJevCheck({ client: new FakeClient(), rules: [astRule], ruleEvidenceReports: readyEvidence(astRule.id) }).checkSource("src/a.ts", source);
    const fingerprint = first.findings[0]?.fingerprint;
    expect(fingerprint).toBeDefined();

    const checker = createJevCheck({
      client: new FakeClient(),
      rules: [astRule],
      ruleEvidenceReports: readyEvidence(astRule.id),
      baseline: [{ ruleId: astRule.id, path: "src/a.ts", fingerprint: fingerprint! }],
    });
    const result = await checker.checkSource("src/a.ts", source);

    expect(result.findings).toHaveLength(0);
    expect(result.suppressedFindings).toHaveLength(1);
    expect(result.suppressedFindings[0]?.suppression).toBe("baseline");
  });

  it("measures mutation recall on real files and excludes pre-existing violations", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-recall-"));
    const src = join(cwd, "src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "a.ts"), "console.log(redacted);");
    await writeFile(
      join(src, "b.ts"),
      ["console.log(secret);", "const marker = \"redacted\";"].join("\n"),
    );

    const checker = createJevCheck({
      client: new FakeClient(),
      rules: [{
        id: "security/no-secret-log",
        question: "Does this code log a secret?",
        threshold: 0.8,
        prefilter: "console\\.log",
        mutants: [{
          id: "redacted-to-secret",
          pattern: "/redacted/g",
          replacement: "secret",
          replaceAll: true,
        }],
      }],
    });

    const result = await checker.recallFiles(["src/a.ts", "src/b.ts"], 12, cwd);

    expect(result.mutants).toEqual([expect.objectContaining({
      ruleId: "security/no-secret-log",
      mutantId: "redacted-to-secret",
      candidateCount: 2,
      sampled: 2,
      judged: 1,
      caught: 1,
      recall: 1,
      misses: [],
      invalidOriginals: ["src/b.ts"],
    })]);
    expect(result.weakestRecall).toBe(1);
  });

  it("rejects unsafe recall sample sizes before sampling", async () => {
    const checker = createJevCheck({
      client: new FakeClient(),
      rules: [{
        id: "security/no-secret-log",
        question: "Does this code log a secret?",
        mutants: [{
          id: "redacted-to-secret",
          pattern: "/redacted/g",
          replacement: "secret",
          replaceAll: true,
        }],
      }],
    });

    await expect(checker.recallFiles([], Number.MAX_SAFE_INTEGER + 1))
      .rejects.toThrow("recall sampleSize must be a positive safe integer");
  });

  it("counts a mutated file with no semantic candidate as a recall miss", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-recall-miss-"));
    const src = join(cwd, "src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "a.ts"), "const value = \"redacted\";");

    const checker = createJevCheck({
      client: new FakeClient(),
      rules: [{
        id: "security/no-secret-log",
        question: "Does this code log a secret?",
        threshold: 0.8,
        prefilter: "console\\.log",
        mutants: [{
          id: "redacted-to-secret",
          pattern: "/redacted/",
          replacement: "secret",
        }],
      }],
    });

    const result = await checker.recallFiles(["src/a.ts"], 12, cwd);

    expect(result.mutants[0]).toMatchObject({
      judged: 1,
      caught: 0,
      recall: 0,
      misses: ["src/a.ts"],
    });
  });

  it("marks a passing fixture exactly 0.05 from threshold as thin", async () => {
    class BoundaryClient implements SystemOneLikeClient {
      async systemOne(): Promise<SystemOneResponse> {
        return {
          model: "boundary-jev",
          answers: { violation: { type: "noul", noul: 0.75 } },
        };
      }
    }
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-thin-"));
    await mkdir(join(cwd, "fixtures"), { recursive: true });
    await writeFile(join(cwd, "fixtures", "valid.ts"), "console.log(redacted);");
    const checker = createJevCheck({
      client: new BoundaryClient(),
      rules: [{
        id: "boundary",
        question: "Is this a violation?",
        threshold: 0.8,
        fixtures: { valid: ["fixtures/valid.ts"] },
      }],
    });
    const result = await checker.testFixtures(cwd);
    expect(result.tests[0]).toMatchObject({ passed: true, margin: 0.05, thinMargin: true });
  });

  it("runs fixtures even when production file globs do not match the fixture path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-"));
    const validDir = join(cwd, "fixtures", "valid");
    const invalidDir = join(cwd, "fixtures", "invalid");
    await mkdir(validDir, { recursive: true });
    await mkdir(invalidDir, { recursive: true });
    await writeFile(join(validDir, "a.ts"), "console.log(redacted);");
    await writeFile(join(invalidDir, "a.ts"), "console.log(secret);");

    const checker = createJevCheck({
      client: new FakeClient(),
      rules: [{
        id: "security/no-secret-log",
        question: "Does this code log a secret?",
        files: ["src/**/*.ts"],
        prefilter: "console\\.log",
        fixtures: {
          valid: ["fixtures/valid/**/*.ts"],
          invalid: ["fixtures/invalid/**/*.ts"],
        },
      }],
    });

    const result = await checker.testFixtures(cwd);
    expect(result.tests).toHaveLength(2);
    expect(result.tests.every((test) => test.passed)).toBe(true);
    expect(result.tests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        expected: "valid",
        maxProbability: 0.05,
        margin: 0.75,
        thinMargin: false,
        semanticKeys: [expect.any(String)],
        model: "fake-jev",
      }),
      expect.objectContaining({
        expected: "invalid",
        maxProbability: 0.95,
        margin: 0.15,
        thinMargin: false,
        semanticKeys: [expect.any(String)],
        model: "fake-jev",
      }),
    ]));
  });
});
