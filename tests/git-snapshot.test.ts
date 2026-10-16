import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { projectConditionMatches } from "../src/applicability.js";
import { loadConfig } from "../src/config.js";
import { currentCoverageEvidence } from "../src/coverage.js";
import { evaluateConfiguredRuleEvidence, persistCoverageEvidence, ruleSourceProvenance } from "../src/evidence-store.js";
import { changedFiles, checkoutGitSnapshot, stagedFiles } from "../src/git.js";
import type { JevCheckConfig, JevCheckRule } from "../src/types.js";

const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}
async function repo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "jevcheck-snapshot-test-"));
  await git(cwd, "init", "-q");
  return cwd;
}
async function put(cwd: string, path: string, content: string): Promise<void> {
  const absolute = join(cwd, path);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content);
}
async function commit(cwd: string, message: string): Promise<void> {
  await git(cwd, "add", "-A");
  await git(cwd, "-c", "user.name=Jevcheck Tests", "-c", "user.email=test@example.com", "commit", "-qm", message);
}

describe("Git evaluation snapshot consistency", () => {
  it("reads staged source, config, manifest, ADR, fixtures and evidence despite unstaged conflicts", async () => {
    const cwd = await repo();
    const rule: JevCheckRule = {
      id: "security/no-log",
      question: "Is a secret logged?",
      wholeFile: true,
      source: "docs/decision.md",
      projectWhen: {
        allOf: [
          { packageJsonHasDep: "express" },
          { fileExists: "src/a.ts" },
          { globMatches: "src/**/*.ts" },
        ],
      },
      coveredBy: [{ id: "coverage", path: "tests/coverage.test.ts" }],
    };
    const config: JevCheckConfig = { include: ["src/**/*.ts"], rules: [rule] };
    const adr = "---\njevcheck-adr: true\nstatus: accepted\n---\nAccepted boundary\n";
    await put(cwd, "jevcheck.config.json", JSON.stringify(config));
    await put(cwd, "package.json", JSON.stringify({ dependencies: { express: "^5" } }));
    await put(cwd, "src/a.ts", "staged source\n");
    await put(cwd, "docs/decision.md", adr);
    await put(cwd, "tests/coverage.test.ts", "staged coverage\n");
    await persistCoverageEvidence(join(cwd, ".jevcheck", "evidence.json"), [rule], cwd);
    await git(cwd, "add", "-A");

    // All of these edits are unstaged. An inconsistent implementation would
    // select staged source but silently apply unstaged policy/evidence.
    await put(cwd, "jevcheck.config.json", JSON.stringify({ ...config, rules: [{ ...rule, question: "Unstaged question" }] }));
    await put(cwd, "package.json", JSON.stringify({ dependencies: {} }));
    await put(cwd, "src/a.ts", "unstaged source\n");
    await put(cwd, "docs/decision.md", adr.replace("accepted", "superseded"));
    await put(cwd, "tests/coverage.test.ts", "unstaged coverage\n");
    await put(cwd, ".jevcheck/evidence.json", JSON.stringify({ version: 1, drift: [], mutation: [], robustness: [], coverage: [] }));

    const snapshot = await checkoutGitSnapshot("index", cwd);
    try {
      expect(await stagedFiles(cwd)).toContain("src/a.ts");
      const snapshotConfig = await loadConfig(join(snapshot.cwd, "jevcheck.config.json"));
      const snapshotRule = snapshotConfig.rules[0]!;
      expect(snapshotRule.question).toBe(rule.question);
      expect(await readFile(join(snapshot.cwd, "src/a.ts"), "utf8")).toBe("staged source\n");
      expect(await projectConditionMatches(rule.projectWhen!, snapshot.cwd)).toBe(true);
      expect((await ruleSourceProvenance(snapshotRule, snapshot.cwd)).decision?.active).toBe(true);
      expect((await currentCoverageEvidence(snapshotRule, snapshot.cwd))?.links[0]?.fingerprint)
        .not.toBe((await currentCoverageEvidence(rule, cwd))?.links[0]?.fingerprint);

      const evaluated = await evaluateConfiguredRuleEvidence(snapshotConfig, {
        cwd: snapshot.cwd,
        modelNamespace: "typesafe:default",
      });
      expect(evaluated.reports[0]?.execution).toBe("covered");
      expect(evaluated.reports[0]?.checks.find((check) => check.id === "applicability")?.message)
        .toContain("applies");
      expect(evaluated.reports[0]?.checks.find((check) => check.id === "architecture-decision")?.message)
        .toContain("accepted");
      expect(evaluated.sourcePaths).toContain("src/a.ts");
    } finally {
      await snapshot.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("evaluates base...HEAD from HEAD, including a renamed destination removed locally", async () => {
    const cwd = await repo();
    await put(cwd, "jevcheck.config.json", JSON.stringify({
      include: ["src/**/*.ts"],
      rules: [{ id: "scope", question: "Is this bad?", wholeFile: true }],
    }));
    await put(cwd, "src/original.ts", "base\n");
    await put(cwd, "src/deleted.ts", "deleted at HEAD\n");
    await commit(cwd, "base");
    const base = await git(cwd, "rev-parse", "HEAD");

    await git(cwd, "mv", "src/original.ts", "src/renamed.ts");
    await git(cwd, "rm", "-q", "src/deleted.ts");
    await put(cwd, "src/renamed.ts", "committed version\n");
    await put(cwd, "src/added.ts", "added at HEAD\n");
    await commit(cwd, "rename and add");

    await put(cwd, "src/renamed.ts", "unstaged version\n");
    await put(cwd, "jevcheck.config.json", JSON.stringify({
      rules: [{ id: "different", question: "Unstaged rule?" }],
    }));
    await git(cwd, "add", "jevcheck.config.json");
    await rm(join(cwd, "src/renamed.ts"));

    const changed = await changedFiles(base, cwd);
    expect(changed).toEqual(["src/added.ts", "src/renamed.ts"]);
    const snapshot = await checkoutGitSnapshot("head", cwd);
    try {
      expect(await readFile(join(snapshot.cwd, "src/renamed.ts"), "utf8")).toBe("committed version\n");
      expect(await readFile(join(snapshot.cwd, "src/added.ts"), "utf8")).toBe("added at HEAD\n");
      expect((await loadConfig(join(snapshot.cwd, "jevcheck.config.json"))).rules[0]?.id).toBe("scope");
      expect(await projectConditionMatches({ fileExists: "src/deleted.ts" }, snapshot.cwd)).toBe(false);
    } finally {
      await snapshot.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not incorporate unstaged or untracked policy files into index mode", async () => {
    const cwd = await repo();
    await put(cwd, "src/a.ts", "staged\n");
    await git(cwd, "add", "src/a.ts");
    await put(cwd, "src/untracked.ts", "untracked\n");
    await put(cwd, "jevcheck.config.json", JSON.stringify({ rules: [{ id: "unstaged", question: "Not staged" }] }));
    const snapshot = await checkoutGitSnapshot("index", cwd);
    try {
      expect(await projectConditionMatches({ fileExists: "src/a.ts" }, snapshot.cwd)).toBe(true);
      expect(await projectConditionMatches({ fileExists: "src/untracked.ts" }, snapshot.cwd)).toBe(false);
      await expect(loadConfig(join(snapshot.cwd, "jevcheck.config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await snapshot.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
