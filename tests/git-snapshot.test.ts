import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { projectConditionMatches } from "../src/applicability.js";
import { loadConfig } from "../src/config.js";
import { currentCoverageEvidence } from "../src/coverage.js";
import { evaluateConfiguredRuleEvidence, persistCoverageEvidence, ruleSourceProvenance } from "../src/evidence-store.js";
import { createJevCheck } from "../src/engine.js";
import { inspectSource } from "../src/inspect.js";
import { changedFiles, checkoutGitSnapshot, stagedFiles, stagedSources } from "../src/git.js";
import { filterFiles } from "../src/files.js";
import { assertSnapshotPaths } from "../src/snapshot-paths.js";
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

      // Inspect and enforcement must use the SAME index snapshot and policy.
      // The working tree intentionally contains retired ADR, stale coverage,
      // a different manifest and different source at this point.
      const stagedContent = await readFile(join(snapshot.cwd, "src/a.ts"), "utf8");
      const inspected = await inspectSource(
        { path: "src/a.ts", source: stagedContent },
        snapshotConfig.rules,
        { ruleEvidenceReports: evaluated.reports, projectRoot: snapshot.cwd },
      );
      const checked = await createJevCheck({
        rules: snapshotConfig.rules,
        ruleEvidenceReports: evaluated.reports,
        projectRoot: snapshot.cwd,
      }).checkSource("src/a.ts", stagedContent);
      expect(inspected.rules[0]?.execution).toBe("covered");
      expect(inspected.rules[0]?.reason).toContain("fingerprints are current");
      expect(inspected.inspections).toHaveLength(0);
      expect(checked.stats.requests).toBe(inspected.inspections.length);
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
  it("checks staged and base changes relative to a nested invocation directory", async () => {
    const cwd = await repo();
    const nested = join(cwd, "packages", "app");
    await put(cwd, "packages/app/jevcheck.config.json", JSON.stringify({
      include: ["src/**/*.ts"],
      rules: [{ id: "local", question: "Is code invalid?", wholeFile: true }],
    }));
    await put(cwd, "packages/app/src/a.ts", "base\n");
    await put(cwd, "elsewhere.ts", "base\n");
    await commit(cwd, "base");
    const base = await git(cwd, "rev-parse", "HEAD");

    await put(cwd, "packages/app/src/a.ts", "staged nested\n");
    await put(cwd, "elsewhere.ts", "changed elsewhere\n");
    await git(cwd, "add", "-A");

    expect(await stagedFiles(nested)).toEqual(["src/a.ts"]);
    expect(await stagedSources(nested)).toEqual([{ path: "src/a.ts", source: "staged nested\n" }]);
    expect(await changedFiles(undefined, nested)).toEqual(["src/a.ts"]);
    const staged = await checkoutGitSnapshot("index", nested);
    try {
      const config = await loadConfig(join(staged.cwd, "jevcheck.config.json"));
      const selected = filterFiles(await stagedFiles(nested), config.include!, []);
      expect(selected).toEqual(["src/a.ts"]);
      expect(await readFile(join(staged.cwd, selected[0]!), "utf8")).toBe("staged nested\n");
    } finally {
      await staged.dispose();
    }

    await commit(cwd, "nested change");
    expect(await changedFiles(base, nested)).toEqual(["src/a.ts"]);
    const head = await checkoutGitSnapshot("head", nested);
    try {
      expect(await readFile(join(head.cwd, "src/a.ts"), "utf8")).toBe("staged nested\n");
      expect((await loadConfig(join(head.cwd, "jevcheck.config.json"))).rules[0]?.id).toBe("local");
    } finally {
      await head.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects trimmed absolute ADR sources and escaping source/fixture patterns", () => {
    const rule: JevCheckRule = { id: "path", question: "Is this unsafe?" };
    const base: JevCheckConfig = { rules: [rule] };
    expect(() => assertSnapshotPaths({ ...base, rules: [{ ...rule, source: " /tmp/live-policy.md" }] }))
      .toThrow("Git snapshots require repository-relative policy paths");
    expect(() => assertSnapshotPaths({ ...base, include: ["../live/**/*.ts"] }))
      .toThrow("Git snapshots require repository-relative policy paths");
    expect(() => assertSnapshotPaths({
      ...base,
      rules: [{ ...rule, fixtures: { valid: ["../fixtures/*.ts"] } }],
    })).toThrow("Git snapshots require repository-relative policy paths");
    expect(() => assertSnapshotPaths({
      ...base,
      rules: [{ ...rule, fixtures: { confirmation: { invalid: ["../confirmation/*.ts"] } } }],
    })).toThrow("Git snapshots require repository-relative policy paths");
    expect(() => assertSnapshotPaths({
      ...base,
      rules: [{ ...rule, source: "docs/accepted.md" }],
    })).not.toThrow();
  });

  it.skipIf(process.platform === "win32")("rejects symlink traversal through intermediate symlinks", async () => {
    const cwd = await repo();
    try {
      await symlink(".", join(cwd, "alias"));
      // The lexical path remains under checkout, but resolving alias then
      // '..' points to checkout's parent, outside the immutable snapshot.
      await symlink("alias/../outside.json", join(cwd, "jevcheck.config.json"));
      await git(cwd, "add", "-A");
      await expect(checkoutGitSnapshot("index", cwd)).rejects.toThrow(/symlink/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("allows links to tracked files inside the snapshot", async () => {
    const cwd = await repo();
    try {
      await put(cwd, "policy.json", "{\"rules\":[]}\n");
      await symlink("policy.json", join(cwd, "jevcheck.config.json"));
      await git(cwd, "add", "-A");
      const snapshot = await checkoutGitSnapshot("index", cwd);
      try {
        expect(await readFile(join(snapshot.cwd, "jevcheck.config.json"), "utf8")).toBe("{\"rules\":[]}\n");
      } finally {
        await snapshot.dispose();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

});
