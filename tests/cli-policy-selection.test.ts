import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cli = resolve("dist/cli.js");
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error("git " + args.join(" ") + ": " + result.stderr);
  return result.stdout.trim();
}
function put(cwd: string, path: string, content: string): void {
  const target = join(cwd, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
function run(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: "utf8", env: { ...process.env, TYPESAFE_API_KEY: "" },
  });
  if (result.error) throw result.error;
  return result;
}
function inspect(cwd: string, ...args: string[]) {
  const result = run(cwd, "inspect", ...args, "--format", "json");
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}
const config = (include = ["src/**/*.ts"], extras: Record<string, unknown> = {}) => JSON.stringify({
  include,
  rules: [{
    id: "rule/new",
    question: "Is this a new policy?",
    wholeFile: true,
    status: "shadow",
  }],
  ...extras,
});
function project(callback: (cwd: string, base: string) => void, configPath = "jevcheck.config.json"): void {
  const cwd = mkdtempSync(join(tmpdir(), "jevcheck-policy-selection-"));
  try {
    git(cwd, "init", "-q");
    put(cwd, configPath, config(["src/**/*.ts"], {
      rules: [{ id: "rule/old", question: "Is this an old policy?", wholeFile: true }],
    }));
    put(cwd, "src/untouched.ts", "const untouched = 1;\n");
    put(cwd, "src/other.ts", "const other = 2;\n");
    git(cwd, "add", "-A");
    git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com",
      "commit", "-qm", "base");
    callback(cwd, git(cwd, "rev-parse", "HEAD"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
function expectFull(result: any, configPath = "jevcheck.config.json", files = 2): void {
  expect(result.data.selection).toEqual({
    mode: "full-policy-change", changedConfig: configPath, selectedFiles: files,
  });
  expect(result.data.rules).toHaveLength(files);
  expect(result.data.rules.map((r: any) => r.path).sort()).toEqual(
    ["src/other.ts", "src/untouched.ts"].slice(0, files),
  );
}

describe("CLI config-change policy scope", () => {
  it("expands a config-only base...HEAD diff to unchanged HEAD sources and new rules", () =>
    project((cwd, base) => {
      put(cwd, "jevcheck.config.json", config());
      git(cwd, "add", "-A");
      git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com",
        "commit", "-qm", "new policy");
      // Both the config and source have diverged in the working tree after HEAD.
      put(cwd, "jevcheck.config.json", config(["nothing/**"], {
        rules: [{ id: "rule/unstaged", question: "wrong source", wholeFile: true }],
      }));
      put(cwd, "src/untouched.ts", "const locallyModified = true;\n");
      const payload = inspect(cwd, "--changed", "--base", base);
      expectFull(payload);
      expect(payload.data.rules.every((r: any) => r.ruleId === "rule/new")).toBe(true);
      expect(payload.data.inspections.map((i: any) => i.request.state.code).join("\n"))
        .not.toContain("locallyModified");
      const human = run(cwd, "inspect", "--changed", "--base", base);
      expect(human.stdout).toContain("Active config changed");
    }));

  it("does not expand on an unchanged config (and honors new excludes)", () =>
    project((cwd, base) => {
      put(cwd, "src/other.ts", "const changed = true;\n");
      git(cwd, "add", "-A");
      git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com",
        "commit", "-qm", "source only");
      const result = inspect(cwd, "--changed", "--base", base);
      expect(result.data.selection).toEqual({ mode: "diff", selectedFiles: 1 });
      expect(result.data.rules.map((r: any) => r.path)).toEqual(["src/other.ts"]);

      put(cwd, "jevcheck.config.json", config(["src/**/*.ts"], { exclude: ["src/other.ts"] }));
      const expanded = inspect(cwd, "--changed");
      expect(expanded.data.selection).toMatchObject({
        mode: "full-policy-change", selectedFiles: 1,
      });
      expect(expanded.data.rules.map((r: any) => r.path)).toEqual(["src/untouched.ts"]);
    }));

  it("uses partially staged index config and sources, never unstaged edits", () =>
    project((cwd) => {
      put(cwd, "jevcheck.config.json", config());
      put(cwd, "src/other.ts", "const stagedContent = true;\n");
      git(cwd, "add", "-A");
      put(cwd, "jevcheck.config.json", config(["src/nothing.ts"], {
        rules: [{ id: "rule/unstaged", question: "Never inspect", wholeFile: true }],
      }));
      put(cwd, "src/other.ts", "const unstagedContent = true;\n");
      const payload = inspect(cwd, "--staged");
      expectFull(payload);
      expect(payload.data.rules.every((r: any) => r.ruleId === "rule/new")).toBe(true);
      const joined = payload.data.inspections.map((i: any) => i.request.state.code).join("\n");
      expect(joined).toContain("stagedContent");
      expect(joined).not.toContain("unstagedContent");
      // Working-tree mode chooses the unstaged policy, not the staged index policy.
      const working = inspect(cwd, "--changed");
      expect(working.data.selection).toMatchObject({ mode: "full-policy-change", selectedFiles: 0 });
    }));

  it("ignores unstaged config changes in staged mode", () =>
    project((cwd) => {
      put(cwd, "src/other.ts", "const staged = true;\n");
      git(cwd, "add", "src/other.ts");
      put(cwd, "jevcheck.config.json", config());
      const payload = inspect(cwd, "--staged");
      expect(payload.data.selection).toEqual({ mode: "diff", selectedFiles: 1 });
      expect(payload.data.rules[0].ruleId).toBe("rule/old");
      expect(payload.data.rules[0].path).toBe("src/other.ts");
    }));

  it("expands working-tree config-only and untracked config additions", () =>
    project((cwd) => {
      put(cwd, "jevcheck.config.json", config());
      const payload = inspect(cwd, "--changed");
      expectFull(payload);
    }));
  it("detects a config staged before the repository's first commit", () => {
    const cwd = mkdtempSync(join(tmpdir(), "jevcheck-config-unborn-"));
    try {
      git(cwd, "init", "-q");
      put(cwd, "src/untouched.ts", "const stable = 1;\\n");
      put(cwd, "jevcheck.config.json", config());
      git(cwd, "add", "-A");
      const payload = inspect(cwd, "--staged");
      expect(payload.data.selection).toMatchObject({
        mode: "full-policy-change", selectedFiles: 1,
      });
      expect(payload.data.rules[0].path).toBe("src/untouched.ts");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("detects a newly-added untracked active config", () => {
    const cwd = mkdtempSync(join(tmpdir(), "jevcheck-config-add-"));
    try {
      git(cwd, "init", "-q");
      put(cwd, "src/untouched.ts", "const stable = 1;\n");
      git(cwd, "add", "-A");
      git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com",
        "commit", "-qm", "no config yet");
      put(cwd, "jevcheck.config.json", config());
      const payload = inspect(cwd, "--changed");
      expect(payload.data.selection).toMatchObject({ mode: "full-policy-change", selectedFiles: 1 });
      expect(payload.data.rules[0].path).toBe("src/untouched.ts");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("supports custom relative config paths and nested invocation directories", () =>
    project((cwd, base) => {
      put(cwd, "config/policy.json", config());
      git(cwd, "add", "-A");
      git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com",
        "commit", "-qm", "add active config");
      const result = inspect(cwd, "--changed", "--base", base, "--config", "config/policy.json");
      expectFull(result, "config/policy.json");
      expect(result.data.rules[0].ruleId).toBe("rule/new");
    }, "config/policy.json"));
  it("uses nested git-relative pathspecs to detect local config changes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "jevcheck-config-nested-"));
    try {
      git(cwd, "init", "-q");
      put(cwd, "packages/app/jevcheck.config.json", config());
      put(cwd, "packages/app/src/untouched.ts", "const stable = 1;\n");
      git(cwd, "add", "-A");
      git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com",
        "commit", "-qm", "base");
      put(cwd, "packages/app/jevcheck.config.json", config(["src/**/*.ts"], { exclude: [] }));
      const result = inspect(join(cwd, "packages", "app"), "--changed");
      expect(result.data.selection).toMatchObject({
        mode: "full-policy-change", selectedFiles: 1,
      });
      expect(result.data.rules[0].path).toBe("src/untouched.ts");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed when a deleted staged or committed config cannot be loaded", () =>
    project((cwd, base) => {
      git(cwd, "rm", "-q", "jevcheck.config.json");
      const staged = run(cwd, "inspect", "--staged", "--format", "json");
      expect(staged.status).toBe(2);
      expect(JSON.parse(staged.stdout)).toMatchObject({
        outcome: "error", error: { code: "CONFIG_ERROR" },
      });
      git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com",
        "commit", "-qm", "remove policy");
      const head = run(cwd, "inspect", "--changed", "--base", base, "--format", "json");
      expect(head.status).toBe(2);
      expect(JSON.parse(head.stdout).error.code).toBe("CONFIG_ERROR");
    }));

  it("makes empty expanded scope explicit without changing exit semantics or SARIF", () =>
    project((cwd, base) => {
      put(cwd, "jevcheck.config.json", config(["src/none/**/*.ts"]));
      git(cwd, "add", "-A");
      git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com",
        "commit", "-qm", "empty policy");
      const result = run(cwd, "--changed", "--base", base, "--format", "json");
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).data.selection).toEqual({
        mode: "full-policy-change", changedConfig: "jevcheck.config.json", selectedFiles: 0,
      });
      const human = run(cwd, "--changed", "--base", base);
      expect(human.stdout).toContain("Active config changed");
      expect(human.stdout).toContain("No files matched");
      const sarif = run(cwd, "--changed", "--base", base, "--format", "sarif");
      expect(sarif.status).toBe(0);
      expect(JSON.parse(sarif.stdout).version).toBe("2.1.0");
    }));

  it("applies full selection in check without provider calls when project policy skips judgments", () =>
    project((cwd, base) => {
      put(cwd, "jevcheck.config.json", config(["src/**/*.ts"], {
        rules: [{
          id: "rule/no-project", question: "Is anything wrong?", wholeFile: true,
          status: "shadow", projectWhen: { fileExists: "src/not-present.ts" },
        }],
      }));
      git(cwd, "add", "-A");
      git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com",
        "commit", "-qm", "inapplicable policy");
      const checked = run(cwd, "--changed", "--base", base, "--format", "json");
      expect(checked.status, checked.stderr || checked.stdout).toBe(0);
      const payload = JSON.parse(checked.stdout);
      expect(payload.data.selection).toMatchObject({
        mode: "full-policy-change", selectedFiles: 2,
      });
      expect(payload.data.stats.filesChecked).toBe(2);
      expect(payload.data.stats.requests).toBe(0);
    }));
});
