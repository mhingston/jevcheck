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
    const checker = createJevCheck({ client, rules: [astRule] });
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
    const checker = createJevCheck({ client: new FakeClient(), rules: [astRule] });

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
    const first = await createJevCheck({ client: new FakeClient(), rules: [astRule] }).checkSource("src/a.ts", source);
    const fingerprint = first.findings[0]?.fingerprint;
    expect(fingerprint).toBeDefined();

    const checker = createJevCheck({
      client: new FakeClient(),
      rules: [astRule],
      baseline: [{ ruleId: astRule.id, path: "src/a.ts", fingerprint: fingerprint! }],
    });
    const result = await checker.checkSource("src/a.ts", source);

    expect(result.findings).toHaveLength(0);
    expect(result.suppressedFindings).toHaveLength(1);
    expect(result.suppressedFindings[0]?.suppression).toBe("baseline");
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
  });
});
