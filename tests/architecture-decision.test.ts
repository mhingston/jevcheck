import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SystemOneLikeClient, SystemOneRequest, SystemOneResponse } from "@mhingston5/jev-cli";
import { parseArchitectureDecision } from "../src/architecture-decision.js";
import { createJevCheck } from "../src/engine.js";
import { evaluateConfiguredRuleEvidence, persistCoverageEvidence, ruleSourceProvenance } from "../src/evidence-store.js";
import type { JevCheckConfig, JevCheckRule } from "../src/types.js";

class CountingClient implements SystemOneLikeClient {
  calls = 0;

  async systemOne(_request: SystemOneRequest): Promise<SystemOneResponse> {
    this.calls += 1;
    return {
      model: "fake-jev",
      answers: { violation: { type: "noul", noul: 0.1 } },
    };
  }
}

const acceptedAdr = [
  "---",
  "jevcheck-adr: true",
  "status: accepted",
  "---",
  "# ADR-004: Customer writes",
  "All writes go through the customer service.",
  "",
].join("\n");

async function fixtureRepository() {
  const cwd = await mkdtemp(join(tmpdir(), "jevcheck-adr-"));
  await mkdir(join(cwd, "src", "customers"), { recursive: true });
  await mkdir(join(cwd, "src", "payments"), { recursive: true });
  await mkdir(join(cwd, "docs", "adr"), { recursive: true });
  await writeFile(join(cwd, "src", "customers", "customer-service.ts"), "export const service = true;\n");
  await writeFile(join(cwd, "src", "customers", "store.ts"), "export async function save() { await db.customer.update({}); }\n");
  await writeFile(join(cwd, "src", "payments", "store.ts"), "export async function pay() { await db.payment.update({}); }\n");
  await writeFile(join(cwd, "docs", "adr", "004-customer-writes.md"), acceptedAdr);
  return cwd;
}

function rule(overrides: Partial<JevCheckRule> = {}): JevCheckRule {
  return {
    id: "architecture/customer-write-boundary",
    source: "docs/adr/004-customer-writes.md",
    status: "shadow",
    files: ["src/customers/**/*.ts"],
    projectWhen: { fileExists: "src/customers/customer-service.ts" },
    wholeFile: true,
    question: "Does this write bypass the customer service?",
    ...overrides,
  };
}

function config(rules: JevCheckRule[]): JevCheckConfig {
  return {
    include: ["src/**/*.ts"],
    rules,
    graduation: {
      requireValidFixture: false,
      requireInvalidFixture: false,
      requireCurrentCalibration: false,
      requireCleanDrift: false,
      requireMutants: false,
      requireSource: false,
    },
  };
}

async function audit(cwd: string, rules: JevCheckRule[]) {
  return evaluateConfiguredRuleEvidence(config(rules), { cwd, modelNamespace: "test:model" });
}

describe("opt-in architecture decision audit", () => {
  it("parses explicitly marked local decisions without interpreting ordinary documents", () => {
    expect(parseArchitectureDecision(acceptedAdr)).toMatchObject({
      status: "accepted",
      active: true,
    });
    expect(parseArchitectureDecision("---\nstatus: superseded\n---\nA normal document"))
      .toBeUndefined();
    expect(parseArchitectureDecision("---\r\njevcheck-adr: true\r\nstatus: superseded\r\n---\r\n"))
      .toMatchObject({ status: "superseded", active: false });
    expect(parseArchitectureDecision("---\njevcheck-adr: true\n---\n"))
      .toMatchObject({ status: "invalid", active: false });
    expect(parseArchitectureDecision("---\njevcheck-adr: true\nstatus: accepted\nsuperseded-by: ADR-009\n---\n"))
      .toMatchObject({ status: "accepted", active: false });
    expect(parseArchitectureDecision("---\njevcheck-adr: true\nstatus: novel\n---\n"))
      .toMatchObject({ status: "novel", active: false });
  });

  it("explains ADR provenance and selects only the applicable component", async () => {
    const cwd = await fixtureRepository();
    const selectedRule = rule();
    const { reports, sourcePaths } = await audit(cwd, [selectedRule]);
    expect(sourcePaths).toHaveLength(3);
    const report = reports[0]!;
    expect(report.execution).toBe("semantic");
    expect(report.checks.find((check) => check.id === "architecture-decision"))
      .toMatchObject({
        status: "pass",
        message: expect.stringContaining("ADR status accepted"),
      });
    expect(report.checks.find((check) => check.id === "architecture-decision")?.message)
      .toContain("matched 2/3 discovered source file(s)");
    expect(report.checks.find((check) => check.id === "applicability")?.message)
      .toContain("applies:");

    const client = new CountingClient();
    const checker = createJevCheck({
      client,
      rules: [selectedRule],
      projectRoot: cwd,
      ruleEvidenceReports: reports,
    });
    await checker.checkSource("src/customers/store.ts", "export async function save() { await db.customer.update({}); }");
    await checker.checkSource("src/payments/store.ts", "export async function pay() { await db.payment.update({}); }");
    expect(client.calls).toBe(1);
  });

  it("does not apply a decision from another component or an absent project", async () => {
    const cwd = await fixtureRepository();
    const selectedRule = rule({
      files: ["src/payments/**/*.ts"],
      projectWhen: { fileExists: "src/billing-service.ts" },
    });
    const { reports } = await audit(cwd, [selectedRule]);
    const report = reports[0]!;
    expect(report.execution).toBe("inapplicable");
    expect(report.checks.find((check) => check.id === "architecture-decision")?.message)
      .toContain("matched 1/3 discovered source file(s)");
    expect(report.checks.find((check) => check.id === "applicability")?.message)
      .toContain("not applicable:");

    const client = new CountingClient();
    const checker = createJevCheck({ client, rules: [selectedRule], ruleEvidenceReports: reports, projectRoot: cwd });
    await checker.checkSource("src/payments/store.ts", "await db.payment.update({});");
    expect(client.calls).toBe(0);
  });

  it("retires superseded decisions before coverage or semantic evaluation", async () => {
    const cwd = await fixtureRepository();
    const decision = join(cwd, "docs", "adr", "004-customer-writes.md");
    const baseRule = rule();
    const originalSource = await ruleSourceProvenance(baseRule, cwd);
    await mkdir(join(cwd, "tests"), { recursive: true });
    await writeFile(join(cwd, "tests", "boundary.test.ts"), "it('enforces customer writes', () => {});");
    const ownedRule = rule({
      status: "owned",
      coveredBy: [{ id: "boundary-test", path: "tests/boundary.test.ts" }],
    });
    const evidenceFile = join(cwd, ".jevcheck", "evidence.json");
    await persistCoverageEvidence(evidenceFile, [ownedRule], cwd);
    await writeFile(
      decision,
      acceptedAdr.replace("status: accepted", "status: superseded\nsuperseded-by: ADR-009"),
    );
    const newSource = await ruleSourceProvenance(baseRule, cwd);
    expect(newSource.fingerprint).not.toBe(originalSource.fingerprint);

    const evaluated = await evaluateConfiguredRuleEvidence(
      { ...config([ownedRule]), evidenceFile },
      { cwd, modelNamespace: "test:model" },
    );
    const report = evaluated.reports[0]!;
    expect(report.execution).toBe("inapplicable");
    expect(report.readyForOwned).toBe(false);
    expect(report.checks.find((check) => check.id === "architecture-decision"))
      .toMatchObject({
        status: "block",
        message: expect.stringContaining("superseded by ADR-009"),
      });
    expect(report.checks.some((check) => check.id === "coverage")).toBe(false);
    expect(() => createJevCheck({ rules: [ownedRule], ruleEvidenceReports: evaluated.reports }))
      .toThrow("cannot be owned");

    const shadow = rule();
    const shadowReports = (await audit(cwd, [shadow])).reports;
    const checker = createJevCheck({ rules: [shadow], ruleEvidenceReports: shadowReports, projectRoot: cwd });
    const result = await checker.checkSource("src/customers/store.ts", "await db.customer.update({});");
    expect(result.stats.requests).toBe(0);
    expect(result.evaluations).toHaveLength(0);
  });

  it("blocks malformed opted-in metadata but preserves ordinary provenance sources", async () => {
    const cwd = await fixtureRepository();
    const path = join(cwd, "docs", "adr", "004-customer-writes.md");
    await writeFile(path, "---\njevcheck-adr: true\nstatus: unknown\n---\n# Example\n");
    const invalid = (await audit(cwd, [rule()])).reports[0]!;
    expect(invalid.execution).toBe("inapplicable");
    expect(invalid.blockers.some((message) => message.includes("Unknown ADR status"))).toBe(true);

    await writeFile(path, "---\nstatus: superseded\n---\n# Ordinary provenance\n");
    const ordinary = (await audit(cwd, [rule()])).reports[0]!;
    expect(ordinary.checks.some((check) => check.id === "architecture-decision")).toBe(false);
    expect(ordinary.execution).toBe("semantic");
  });
});
