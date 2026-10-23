import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { projectSpecForge } from "../src/specforge.js";
import { inspectSource } from "../src/inspect.js";
import { parseConfig } from "../src/config.js";

const guarantee = "A generated rule MUST remain in shadow status regardless of mapping input.";
const source = "spec/projection.spec#projected_rules_stay_advisory";

function graph() {
  return {
    format_version: "2.0",
    schema_version: "1.0.0",
    nodes: [
      { id: "projected_rules_stay_advisory", kind: "invariant", file: "projection.spec",
        fields: { guarantee } },
      { id: "project_invariants", kind: "behavior", file: "projection.spec", fields: {} },
    ],
    edges: [{ source: "project_invariants", target: "projected_rules_stay_advisory",
      label: "invariants" }],
  };
}

function mapping() {
  return {
    include: ["src/specforge.ts"],
    rules: [{
      invariant: "projected_rules_stay_advisory",
      expectedGuarantee: guarantee,
      source,
      id: "architecture/specforge-shadow-only",
      question: "Can this projection return an owned rule or permit a mapping to set owned status?",
      ast: "function_declaration",
      contains: "status",
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
      id: "architecture/specforge-shadow-only",
      source, why: guarantee, status: "shadow",
    });
    expect(parseConfig(projected).rules[0]?.prefilter).toBe("status");
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
    entry.source = "../outside.spec#projected_rules_stay_advisory";
    expect(() => projectSpecForge(graph(), owned)).toThrow(/repository-relative/);
    entry.source = "spec/other.spec#projected_rules_stay_advisory";
    expect(() => projectSpecForge(graph(), owned)).toThrow(/differs/);
  });

  it("refuses partial graphs and unscoped semantic rules", () => {
    expect(() => projectSpecForge({ ...graph(), token_budget: {} }, mapping()))
      .toThrow(/budgeted/);
    const unscoped = mapping();
    const entry = unscoped.rules[0]! as Record<string, unknown>;
    delete entry.ast;
    delete entry.contains;
    expect(() => projectSpecForge(graph(), unscoped)).toThrow(/selector/);
  });

  it("dogfoods generated selection with valid and invalid source fixtures, provider-free", async () => {
    const checked = parseConfig(projectSpecForge(graph(), mapping()));
    for (const kind of ["valid", "invalid"] as const) {
      const path = "examples/specforge/fixtures/" + kind + "/status.ts";
      const result = await inspectSource(
        { path, source: readFileSync(join(process.cwd(), path), "utf8") },
        checked.rules,
      );
      expect(result.diagnostics).toEqual([]);
      expect(result.inspections).toHaveLength(1);
      expect(result.inspections[0]?.request.question).toMatch(/owned rule/);
    }
  });
});
