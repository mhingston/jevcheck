import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { projectSpecForge } from "../src/specforge.js";
import { inspectSource } from "../src/inspect.js";
import { parseConfig } from "../src/config.js";

const guarantee = "The CLI MUST NOT report successful projection when validation or output writing fails without successful recovery.";
const source = "spec/projection.spec#projection_must_not_ack_failed_validation";

function graph() {
  return {
    format_version: "2.0",
    schema_version: "1.0.0",
    nodes: [
      { id: "projection_must_not_ack_failed_validation", kind: "invariant", file: "projection.spec",
        fields: { guarantee } },
      { id: "project_invariants", kind: "behavior", file: "projection.spec", fields: {} },
    ],
    edges: [{ source: "project_invariants", target: "projection_must_not_ack_failed_validation",
      label: "invariants" }],
  };
}

function mapping() {
  return {
    include: ["src/cli.ts"],
    rules: [{
      invariant: "projection_must_not_ack_failed_validation",
      expectedGuarantee: guarantee,
      source,
      id: "reliability/specforge-no-success-after-failure",
      question: "Can this CLI report successful projection after projectSpecForge or writing output fails, without successful recovery?",
      ast: "function_declaration",
      contains: "projectSpecForge(",
      criteria: {
        true: "A validation or write failure is swallowed, but the CLI still reports successful projection.",
        false: "Success is reported only after completed validation and output writing; failures produce a non-success exit.",
      },
      fixtures: {
        valid: ["examples/specforge/fixtures/valid/**/*.ts"],
        invalid: ["examples/specforge/fixtures/invalid/**/*.ts"],
      },
    }],
  };
}

describe("SpecForge → jevcheck projection", () => {
  it("projects a linked invariant to a valid, always-shadow jevcheck rule", () => {
    const projected = projectSpecForge(graph(), mapping());
    expect(projected.rules).toHaveLength(1);
    expect(projected.rules[0]).toMatchObject({
      id: "reliability/specforge-no-success-after-failure",
      source, why: guarantee, status: "shadow",
    });
    expect(parseConfig(projected).rules[0]?.prefilter).toBe("projectSpecForge\\(");
  });

  it("rejects semantic drift until the mapping is reviewed again", () => {
    const changed = graph();
    changed.nodes[0]!.fields.guarantee = "The rule MAY be owned.";
    expect(() => projectSpecForge(changed, mapping())).toThrow(/guarantee drift/);
  });

  it("rejects unmapped, unlinked and duplicate entity IDs", () => {
    const missing = mapping();
    missing.rules[0]!.invariant = "absent";
    expect(() => projectSpecForge(graph(), missing)).toThrow(/does not exist/);
    const unlinked = graph();
    unlinked.edges = [];
    expect(() => projectSpecForge(unlinked, mapping())).toThrow(/not enforced/);
    const duplicates = graph();
    duplicates.nodes.push({ ...duplicates.nodes[0]! });
    expect(() => projectSpecForge(duplicates, mapping())).toThrow(/duplicate graph/);
  });

  it("refuses ownership and caller-controlled source metadata", () => {
    const owned = mapping();
    const entry = owned.rules[0]! as Record<string, unknown>;
    entry.status = "owned";
    expect(() => projectSpecForge(graph(), owned)).toThrow(/cannot set status/);
    delete entry.status;
    entry.coveredBy = [{ id: "fake", path: "tests/anything.test.ts" }];
    expect(() => projectSpecForge(graph(), owned)).toThrow(/cannot set status/);
    delete entry.coveredBy;
    entry.source = "../outside.spec#projection_must_not_ack_failed_validation";
    expect(() => projectSpecForge(graph(), owned)).toThrow(/repository-relative/);
    entry.source = "spec/other.spec#projection_must_not_ack_failed_validation";
    expect(() => projectSpecForge(graph(), owned)).toThrow(/differs/);
  });

  it.each([
    " ../projection.spec#projection_must_not_ack_failed_validation",
    "spec/ ../projection.spec#projection_must_not_ack_failed_validation",
    "spec/ projection.spec#projection_must_not_ack_failed_validation",
    "https://example.com/projection.spec#projection_must_not_ack_failed_validation",
    "file:///spec/projection.spec#projection_must_not_ack_failed_validation",
    "C:spec/projection.spec#projection_must_not_ack_failed_validation",
    "C:/spec/projection.spec#projection_must_not_ack_failed_validation",
    "\\\\server\\share\\projection.spec#projection_must_not_ack_failed_validation",
    "spec\\projection.spec#projection_must_not_ack_failed_validation",
    "./spec/projection.spec#projection_must_not_ack_failed_validation",
    "spec//projection.spec#projection_must_not_ack_failed_validation",
  ])("rejects unsafe provenance %s", (unsafeSource) => {
    const data = mapping();
    data.rules[0]!.source = unsafeSource;
    expect(() => projectSpecForge(graph(), data)).toThrow(/canonical repository-relative/);
  });

  it("refuses partial graphs and unscoped semantic rules", () => {
    expect(() => projectSpecForge({ ...graph(), token_budget: {} }, mapping()))
      .toThrow(/budgeted/);
    // Scoped exports carry schema_ref but may omit token_budget entirely.
    // Even a graph retaining both of our mapped nodes is not a full export.
    expect(() => projectSpecForge({
      ...graph(),
      schema_ref: { schema_version: "1.0.0", content_hash: "abcd" },
    }, mapping())).toThrow(/scoped/);
    const unscoped = mapping();
    const entry = unscoped.rules[0]! as Record<string, unknown>;
    delete entry.ast;
    delete entry.contains;
    expect(() => projectSpecForge(graph(), unscoped)).toThrow(/selector/);
  });

  it("dogfoods generated selection with valid and invalid source fixtures, provider-free", async () => {
    const checked = parseConfig(projectSpecForge(graph(), mapping()));
    for (const kind of ["valid", "invalid"] as const) {
      const path = "examples/specforge/fixtures/" + kind + "/cli.ts";
      const result = await inspectSource(
        { path, source: readFileSync(join(process.cwd(), path), "utf8") },
        checked.rules,
      );
      expect(result.diagnostics).toEqual([]);
      expect(result.inspections).toHaveLength(1);
      expect(JSON.stringify(result.inspections[0]?.request.question)).toMatch(/successful projection/);
    }
  });
  it("supports generate, drift check and JSON errors via the main jevcheck CLI", () => {
    const cwd = mkdtempSync(join(tmpdir(), "jevcheck-specforge-"));
    const cli = resolve("dist/cli.js");
    const target = join(cwd, "jevcheck.config.json");
    const graphPath = join(cwd, "graph.json");
    const mappingPath = join(cwd, "mapping.json");
    const execute = (extra: string[] = []) => {
      const result = spawnSync(process.execPath, [
        cli, "specforge", "project",
        "--graph", graphPath, "--mapping", mappingPath, "--output", target, ...extra,
      ], { cwd, encoding: "utf8" });
      if (result.error) throw result.error;
      return result;
    };
    try {
      writeFileSync(graphPath, JSON.stringify(graph()));
      writeFileSync(mappingPath, JSON.stringify(mapping()));
      // No default jevcheck.config.json exists in this temporary workspace.
      const generated = execute();
      expect(generated.status).toBe(0);
      expect(generated.stderr).toBe("");
      expect(generated.stdout).toContain("shadow rules only");
      const actual = JSON.parse(readFileSync(target, "utf8"));
      expect(actual.rules[0].status).toBe("shadow");

      const checked = execute(["--check", "--format", "json"]);
      expect(checked.status).toBe(0);
      expect(JSON.parse(checked.stdout)).toMatchObject({
        command: "specforge-project", outcome: "pass",
        data: { checked: true, rules: 1, status: "shadow" },
      });

      writeFileSync(target, "{}\n");
      const stale = execute(["--check", "--format", "json"]);
      expect(stale.status).toBe(2);
      expect(stale.stderr).toBe("");
      expect(JSON.parse(stale.stdout)).toMatchObject({
        command: "specforge-project", outcome: "error",
      });
      expect(readFileSync(target, "utf8")).toBe("{}\n");

      const disallowed = execute(["--check", "--provider", "typesafe", "--format", "json"]);
      expect(disallowed.status).toBe(2);
      expect(JSON.parse(disallowed.stdout).error.code).toBe("INVALID_ARGUMENT");

      const missing = spawnSync(process.execPath, [cli, "specforge", "project",
        "--format", "json"], { cwd, encoding: "utf8" });
      expect(missing.status).toBe(2);
      expect(JSON.parse(missing.stdout)).toMatchObject({
        command: "specforge-project", outcome: "error",
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

});
