import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SystemOneLikeClient, SystemOneRequest, SystemOneResponse } from "@mhingston5/jev-cli";
import { MemoryAnswerCache } from "../src/cache.js";
import { createJevCheck } from "../src/engine.js";

class FakeClient implements SystemOneLikeClient {
  calls = 0;

  async systemOne(request: SystemOneRequest): Promise<SystemOneResponse> {
    this.calls += 1;
    const state = request.state as { code: string };
    const probability = state.code.includes("console.log(secret)") ? 0.95 : 0.05;
    return {
      model: "fake-jev",
      answers: {
        violation: { type: "noul", noul: probability },
      },
      usage: { input_tokens: 10, output_tokens: 1 },
    };
  }
}

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
