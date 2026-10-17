import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cli = resolve("dist/cli.js");
function execute(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const run = spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: "utf8", env: { ...process.env, ...env },
  });
  if (run.error) throw run.error;
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}
function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error("git " + args.join(" ") + ": " + result.stderr);
  return result.stdout.trim();
}
function project(test: (cwd: string) => void) {
  const cwd = mkdtempSync(join(tmpdir(), "jevcheck-cli-json-"));
  try {
    mkdirSync(join(cwd, "src"), { recursive: true });
    mkdirSync(join(cwd, "tests"), { recursive: true });
    writeFileSync(join(cwd, "src", "demo.ts"), "const ok = true;\n");
    writeFileSync(join(cwd, "tests", "coverage.test.ts"), "it('works', () => {});\n");
    writeFileSync(join(cwd, "jevcheck.config.json"), JSON.stringify({
      rules: [{
        id: "sample/coverage", status: "owned", question: "Is the code invalid?",
        wholeFile: true, files: ["src/**/*.ts"],
        coveredBy: [{ id: "unit", path: "tests/coverage.test.ts" }],
      }],
      include: ["src/**/*.ts"],
    }));
    test(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("CLI JSON stdout contract (built binary)", () => {
  it.each([
    ["--format", "json", "--unknown"],
    ["inspect", "--config", "missing.json", "--format", "json"],
  ])("returns one JSON error with separate stderr for %j", (...args) => project((cwd) => {
    const run = execute(cwd, args);
    expect(run.code).toBe(2);
    expect(run.stderr).toBe("");
    const result = JSON.parse(run.stdout);
    expect(result.outcome).toBe("error");
    expect(result.diagnostics[0].code).toBeTruthy();
    expect(result.error.remediation).toBeTruthy();
  }));

  it("uses JSON errors when the last format is JSON", () => project((cwd) => {
    const lastJson = execute(cwd, ["inspect", "--format", "stylish", "--format", "json", "--oops"]);
    expect(lastJson.code).toBe(2);
    expect(JSON.parse(lastJson.stdout)).toMatchObject({ schemaVersion: 1, outcome: "error" });
  }));

  it("uses stderr when the last format is stylish", () => project((cwd) => {
    const lastStylish = execute(cwd, ["inspect", "--format", "json", "--format", "stylish", "--oops"]);
    expect(lastStylish.code).toBe(2);
    expect(lastStylish.stdout).toBe("");
    expect(lastStylish.stderr).toContain("unknown option");
  }));

  it("returns JSON help when the last format is JSON", () => project((cwd) => {
    const help = execute(cwd, ["--format", "stylish", "--format", "json", "--help"]);
    expect(help.code).toBe(0);
    expect(JSON.parse(help.stdout)).toMatchObject({ schemaVersion: 1, command: "help" });
  }));

  it("keeps JSON errors when a format override is missing", () => project((cwd) => {
    const missingOverride = execute(cwd, ["inspect", "--format", "json", "--format", "--help"]);
    expect(missingOverride.code).toBe(2);
    expect(missingOverride.stderr).toBe("");
    expect(JSON.parse(missingOverride.stdout)).toMatchObject({
      command: "inspect", outcome: "error",
      error: { code: "INVALID_ARGUMENT" },
    });
  }));

  it("keeps JSON errors when a format override is invalid", () => project((cwd) => {
    const invalidOverride = execute(cwd, ["inspect", "--format", "json", "--format", "bogus"]);
    expect(invalidOverride.code).toBe(2);
    expect(JSON.parse(invalidOverride.stdout)).toMatchObject({
      command: "inspect", error: { code: "INVALID_ARGUMENT" },
    });
  }));

  it("rejects the obsolete JSON format", () => project((cwd) => {
    const obsolete = execute(cwd, ["inspect", "--format", "json-v2"]);
    expect(obsolete.code).toBe(2);
    expect(obsolete.stderr).toContain("--format must be stylish, json, or sarif");
  }));

  it("uses structured CONFIG_ERROR for invalid rule configuration", () => project((cwd) => {
    writeFileSync(join(cwd, "jevcheck.config.json"), JSON.stringify({
      rules: [{ id: "sample/coverage", question: "Problem?", threshold: 2 }],
    }));
    const result = execute(cwd, ["inspect", "--format", "json"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "inspect", outcome: "error",
      error: { code: "CONFIG_ERROR" }, data: null,
    });
  }));

  it("returns detailed evidence blockers on owned-rule enforcement failures", () => project((cwd) => {
    git(cwd, ["init"]);
    git(cwd, ["add", "."]);
    git(cwd, ["-c", "user.name=CI Test", "-c", "user.email=ci@example.test", "commit", "-m", "snapshot"]);
    const result = execute(cwd, ["--format", "json"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    if (output.error?.code !== "OWNED_RULE_EVIDENCE_BLOCKED") {
      throw new Error("Unexpected owned-check failure: " + JSON.stringify(output));
    }
    expect(output).toMatchObject({
      command: "check", outcome: "error",
      error: { code: "OWNED_RULE_EVIDENCE_BLOCKED", ruleId: "sample/coverage" },
    });
    expect(output.data.evidenceReports[0]).toMatchObject({
      ruleId: "sample/coverage", currentStatus: "owned", readyForOwned: false,
    });
    expect(output.data.evidenceReports[0].blockers.length).toBeGreaterThan(0);
    expect(output.diagnostics.some((d: { ruleId?: string; code: string }) =>
      d.ruleId === "sample/coverage" && d.code.startsWith("EVIDENCE_"))).toBe(true);
  }));

  it("keeps inspection complete in JSON and concise for humans", () => project((cwd) => {
    const human = execute(cwd, ["inspect"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("Inspect:");
    expect(human.stdout).not.toContain("semantic key:");
    expect(human.stdout).not.toContain("exact request");
    const verbose = execute(cwd, ["inspect", "--verbose"]);
    expect(verbose.stdout).toContain("semantic key:");
    const agent = execute(cwd, ["inspect", "--format", "json"]);
    expect(agent.code).toBe(0);
    const payload = JSON.parse(agent.stdout);
    expect(payload).toMatchObject({ schemaVersion: 1, command: "inspect", outcome: "pass" });
    expect(payload.data.rules.length).toBeGreaterThan(0);
    expect(payload.data.inspections.length).toBeGreaterThan(0);
    expect(payload.data.inspections[0].request).toBeTruthy();
  }));

  it("returns a consistent JSON envelope for audit and no-match inspection", () => project((cwd) => {
    const audit = execute(cwd, ["rules", "audit", "--format", "json"]);
    expect(audit.code).toBe(0);
    const audits = JSON.parse(audit.stdout);
    expect(audits).toMatchObject({ schemaVersion: 1, command: "rules-audit" });
    expect(Array.isArray(audits.data)).toBe(true);
    expect(audits.data[0].state).toBeTruthy();
    expect(audits.data[0].checks).toBeTruthy();
    const empty = execute(cwd, ["inspect", "nothing/**/*.ts", "--format", "json"]);
    expect(empty.code).toBe(0);
    expect(JSON.parse(empty.stdout)).toMatchObject({
      command: "inspect", summary: { rules: 0, candidates: 0 },
    });
  }));

  it("redirects noisy failed coverage child stdout to stderr and returns one JSON result", () => project((cwd) => {
    git(cwd, ["init"]);
    git(cwd, ["add", "."]);
    git(cwd, ["-c", "user.name=CI Test", "-c", "user.email=ci@example.test", "commit", "-m", "snapshot"]);
    const sha = git(cwd, ["rev-parse", "HEAD"]);
    const env = {
      GITHUB_ACTIONS: "true", GITHUB_SHA: sha,
      GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_JOB: "cli_json_test",
    };
    const recorded = execute(cwd, ["coverage", "record", "--attest-reviewed", "--format", "json"], env);
    expect(recorded.code).toBe(0);
    expect(JSON.parse(recorded.stdout).data.reviewed).toBe(true);
    const verified = execute(cwd, ["coverage", "verify", "--check", "unit", "--format", "json",
      "--", process.execPath, "-e", "console.log('NOISY_STDOUT'); console.error('NOISY_STDERR'); process.exit(7);"], env);
    expect(verified.code).toBe(7);
    expect(verified.stdout).not.toContain("NOISY_STDOUT");
    expect(verified.stderr).toContain("NOISY_STDOUT");
    const parsed = JSON.parse(verified.stdout);
    expect(parsed).toMatchObject({
      schemaVersion: 1, command: "coverage-verify", outcome: "block",
      data: { checkId: "unit", status: "failed" },
    });
  }));
});
