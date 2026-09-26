import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SystemOneLikeClient, SystemOneRequest, SystemOneResponse } from "@mhingston5/jev-cli";
import { createJevCheck } from "../src/engine.js";
import {
  DiskSemanticDecisionStore,
  MemorySemanticDecisionStore,
} from "../src/replay.js";

class FakeClient implements SystemOneLikeClient {
  calls = 0;

  async systemOne(_request: SystemOneRequest): Promise<SystemOneResponse> {
    this.calls += 1;
    return {
      model: "fake-jev",
      answers: {
        violation: { type: "noul", noul: 0.95 },
      },
      usage: { input_tokens: 10, output_tokens: 1 },
    };
  }
}

const rule = {
  id: "security/no-secret-log",
  question: "Does this code log a secret?",
  status: "owned" as const,
  severity: "error" as const,
  threshold: 0.8,
  ast: { pattern: "console.log($A)", contextBefore: 0, contextAfter: 0 },
};

describe("semantic replay", () => {
  it("records a live decision and replays it offline across policy-only changes", async () => {
    const store = new MemorySemanticDecisionStore();
    const client = new FakeClient();
    const source = "console.log(secret);";

    const live = createJevCheck({
      client,
      rules: [rule],
      decisionStore: store,
      mode: "measure",
    });
    const recorded = await live.checkSource("src/a.ts", source);

    expect(client.calls).toBe(1);
    expect(await store.count()).toBe(1);
    expect(recorded.findings).toHaveLength(1);

    const replay = createJevCheck({
      rules: [{ ...rule, threshold: 0.99, status: "shadow" }],
      decisionStore: store,
      replayOnly: true,
      mode: "measure",
    });
    const result = await replay.checkSource("src/a.ts", source);

    expect(result.stats.requests).toBe(0);
    expect(result.stats.replayHits).toBe(1);
    expect(result.stats.replayMisses).toBe(0);
    expect(result.evaluations[0]).toMatchObject({
      probability: 0.95,
      threshold: 0.99,
      replayed: true,
      model: "fake-jev",
    });
    expect(result.findings).toHaveLength(0);
  });

  it("reports a strict replay miss when semantic inputs change", async () => {
    const store = new MemorySemanticDecisionStore();
    const client = new FakeClient();
    const source = "console.log(secret);";

    await createJevCheck({
      client,
      rules: [rule],
      decisionStore: store,
      mode: "measure",
    }).checkSource("src/a.ts", source);

    const replay = createJevCheck({
      rules: [{ ...rule, question: "Does this logging call expose a credential?" }],
      decisionStore: store,
      replayOnly: true,
      mode: "measure",
    });
    const result = await replay.checkSource("src/a.ts", source);

    expect(client.calls).toBe(1);
    expect(result.evaluations).toHaveLength(0);
    expect(result.stats.replayHits).toBe(0);
    expect(result.stats.replayMisses).toBe(1);
    expect(result.diagnostics[0]).toMatchObject({
      level: "error",
      path: "src/a.ts",
      ruleId: rule.id,
    });
    expect(result.diagnostics[0]?.message).toContain("Replay miss");
  });

  it("persists a versioned replay corpus only when flushed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-replay-"));
    const path = join(cwd, "replay.json");
    const store = new DiskSemanticDecisionStore(path);

    await store.set({
      key: "a".repeat(64),
      semanticHash: "b".repeat(64),
      stateHash: "c".repeat(64),
      ruleId: "example",
      path: "src/a.ts",
      startLine: 1,
      endLine: 1,
      probability: 0.42,
      model: "fake-jev",
    });
    await store.flush();

    const replay = new DiskSemanticDecisionStore(path, true);
    expect(await replay.count()).toBe(1);
    expect((await replay.get("a".repeat(64)))?.probability).toBe(0.42);
  });

  it("keeps corpus parse failures sticky instead of turning them into misses", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-replay-invalid-"));
    const path = join(cwd, "replay.json");
    await writeFile(path, "{ invalid json", "utf8");
    const replay = new DiskSemanticDecisionStore(path, true);

    await expect(replay.count()).rejects.toThrow();
    await expect(replay.get("missing")).rejects.toThrow();
  });

  it("fails clearly when a read-only replay corpus does not exist", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-replay-missing-"));
    const replay = new DiskSemanticDecisionStore(join(cwd, "missing.json"), true);
    await expect(replay.count()).rejects.toThrow("run jevcheck record first");
  });
});
