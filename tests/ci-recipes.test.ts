import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(".");
const cli = resolve("dist/cli.js");

function exec(command: string, args: string[], cwd: string) {
  // Provider credentials are intentionally not passed to the offline checks.
  const { TYPESAFE_API_KEY, OPENROUTER_API_KEY, JEV_API_KEY, ...env } = process.env;
  void TYPESAFE_API_KEY; void OPENROUTER_API_KEY; void JEV_API_KEY;
  const run = spawnSync(command, args, { cwd, encoding: "utf8", env });
  if (run.error) throw run.error;
  return run;
}

function git(cwd: string, ...args: string[]) {
  const result = exec("git", args, cwd);
  if (result.status !== 0) throw new Error(result.stderr);
}

describe("consumer CI recipes (provider-free)", () => {
  it("contains exact revision, fetch, opt-in and no-swallowing safeguards", () => {
    const github = readFileSync(join(root, "examples/ci/github-actions.yml"), "utf8");
    const azure = readFileSync(join(root, "examples/ci/azure-pipelines.yml"), "utf8");
    for (const content of [github, azure]) {
      expect(content).toContain("fetch");
      expect(content).toContain("npm ci");
      expect(content).toContain("jevcheck inspect --changed --base");
      expect(content).toContain("jevcheck rules audit --format json");
      expect(content).toContain("jevcheck --changed --base");
      expect(content).toContain("--format sarif");
      expect(content).toContain("JEV_ENABLE_SEMANTIC_CHECK");
      expect(content).not.toMatch(/^\s*continue-on-error:\s*true/m);
      expect(content).not.toMatch(/\|\|\s*true/);
    }
    expect(github).toContain("fetch-depth: 0");
    expect(github).toContain('test "$(git rev-parse HEAD)" = "$GITHUB_SHA"');
    expect(github).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(azure).toContain("fetchDepth: 0");
    expect(azure).toContain("System.PullRequest.TargetBranch");
    expect(azure).toContain("persistCredentials: true");
    expect(azure).toContain("does NOT have trusted coveredBy");
  });

  it("runs full and HEAD-vs-base inspections plus readiness audit without a provider", () => {
    const cwd = mkdtempSync(join(tmpdir(), "jevcheck-ci-recipe-"));
    try {
      mkdirSync(join(cwd, "src"), { recursive: true });
      copyFileSync(join(root, "examples/ci/sample/jevcheck.config.json"), join(cwd, "jevcheck.config.json"));
      const source = readFileSync(join(root, "examples/ci/sample/src/handler.ts"), "utf8");
      writeFileSync(join(cwd, "src/handler.ts"), source);
      git(cwd, "init", "-q");
      git(cwd, "add", ".");
      git(cwd, "-c", "user.name=CI Test", "-c", "user.email=ci@example.test", "commit", "-qm", "base");
      const full = exec(process.execPath, [cli, "inspect", "--format", "json"], cwd);
      expect(full.status).toBe(0);
      const fullJson = JSON.parse(full.stdout);
      expect(fullJson.data.preflight.eligibleCandidates).toBeGreaterThan(0);
      expect(fullJson.data.selection.mode).toBe("full");

      writeFileSync(join(cwd, "src/handler.ts"), source + "// PR edit\n");
      git(cwd, "add", ".");
      git(cwd, "-c", "user.name=CI Test", "-c", "user.email=ci@example.test", "commit", "-qm", "change");
      const diff = exec(process.execPath, [cli, "inspect", "--changed", "--base", "HEAD~1", "--format", "json"], cwd);
      expect(diff.status).toBe(0);
      const diffJson = JSON.parse(diff.stdout);
      expect(diffJson.data.selection.mode).toBe("diff");
      expect(diffJson.data.selection.selectedFiles).toBe(1);
      expect(diffJson.data.preflight.eligibleCandidates).toBeGreaterThan(0);

      const audit = exec(process.execPath, [cli, "rules", "audit", "--format", "json"], cwd);
      expect(audit.status).toBe(0);
      const auditJson = JSON.parse(audit.stdout);
      expect(auditJson.command).toBe("rules-audit");
      expect(auditJson.data).toHaveLength(1);
      expect(auditJson.data[0].readyForOwned).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
