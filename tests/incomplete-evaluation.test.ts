import { describe, expect, it } from "vitest";
import type { SystemOneLikeClient, SystemOneRequest, SystemOneResponse } from "@mhingston5/jev-cli";
import { createJevCheck } from "../src/engine.js";
import { formatSarif, formatStylish } from "../src/format.js";
import type { JevCheckRule } from "../src/types.js";

class CountingClient implements SystemOneLikeClient {
  calls = 0;
  requestLengths: number[] = [];

  async systemOne(request: SystemOneRequest): Promise<SystemOneResponse> {
    this.calls += 1;
    this.requestLengths.push((request.state as { code: string }).code.length);
    return { model: "test-model", answers: { violation: { type: "noul", noul: 0.1 } } };
  }
}

function checker(rule: JevCheckRule, client: CountingClient, mode: "enforce" | "measure" = "enforce") {
  return createJevCheck({
    client,
    rules: [rule],
    mode,
    chunkChars: 256,
    overlapLines: 0,
    ruleEvidenceReports: rule.status === "owned" ? [{
      ruleId: rule.id,
      currentStatus: "owned" as const,
      checks: [],
      blockers: [],
      warnings: [],
      readyForOwned: true,
    }] : undefined,
  });
}

const skipped: Array<{
  label: string;
  path: string;
  source: string;
  selector: Partial<JevCheckRule>;
}> = [
  {
    label: "an oversized whole file",
    path: "src/a.ts",
    source: "x".repeat(300),
    selector: { wholeFile: true },
  },
  {
    label: "an oversized AST match",
    path: "src/a.ts",
    source: "console.log(" + JSON.stringify("x".repeat(300)) + ");",
    selector: { ast: { pattern: "console.log($A)", contextBefore: 0, contextAfter: 0 } },
  },
  {
    label: "an oversized source line",
    path: "src/a.ts",
    source: ["const a = 1;", "x".repeat(300), "const b = 2;"].join("\n"),
    selector: {},
  },
  {
    label: "an unsupported AST extension",
    path: "src/a.vue",
    source: "console.log(secret);",
    selector: { ast: { pattern: "console.log($A)" } },
  },
];

describe("incomplete semantic evaluation", () => {
  it.each(skipped)("fails an owned error check for $label", async ({ path, source, selector }) => {
    const client = new CountingClient();
    const rule: JevCheckRule = {
      id: "test/incomplete",
      question: "Does this violate the invariant?",
      status: "owned",
      severity: "error",
      ...selector,
    };
    const result = await checker(rule, client).checkSource(path, source);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "incomplete-evaluation",
        level: "error",
        path,
        ruleId: rule.id,
      }),
    ]));
    expect(result.findings).toHaveLength(0);
    expect(client.requestLengths.every((n) => n <= 256)).toBe(true);
    expect(formatStylish(result)).toContain("error " + path);
    expect(formatStylish(result)).toContain("[incomplete-evaluation]");

    const sarif = JSON.parse(formatSarif(result)) as {
      runs: Array<{ invocations: Array<{
        executionSuccessful: boolean;
        toolExecutionNotifications: Array<{ level: string; properties?: { code: string } }>;
      }> }>;
    };
    expect(sarif.runs[0]?.invocations[0]?.executionSuccessful).toBe(false);
    expect(sarif.runs[0]?.invocations[0]?.toolExecutionNotifications)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        level: "error",
        properties: { code: "incomplete-evaluation" },
      })]));
  });

  it("keeps a genuine AST zero-match successful", async () => {
    const client = new CountingClient();
    const result = await checker({
      id: "test/no-match",
      question: "Is the call unsafe?",
      status: "owned",
      ast: { pattern: "console.log($A)" },
    }, client).checkSource("src/a.ts", "const ok = true;");
    expect(result.diagnostics).toEqual([]);
    expect(result.evaluations).toEqual([]);
    expect(JSON.parse(formatSarif(result)).runs[0].invocations[0].executionSuccessful).toBe(true);
    expect(client.calls).toBe(0);
  });

  it("keeps genuinely excluded oversized whole files successful", async () => {
    for (const selector of [
      { prefilter: "queue\\.publish", wholeFile: true },
      { unless: "skip-this-file", wholeFile: true },
    ]) {
      const result = await checker({
        id: "test/excluded",
        question: "Does this violate the invariant?",
        status: "owned",
        ...selector,
      }, new CountingClient()).checkSource("src/a.ts", "skip-this-file".repeat(40));
      expect(result.diagnostics).toEqual([]);
      expect(result.evaluations).toEqual([]);
    }
  });

  it("keeps incompleteness advisory for shadow, owned warning and measurement modes", async () => {
    for (const [status, severity, mode] of [
      ["shadow", "error", "enforce"],
      ["owned", "warning", "enforce"],
      ["owned", "error", "measure"],
    ] as const) {
      const client = new CountingClient();
      const rule: JevCheckRule = {
        id: "test/advisory",
        question: "Is this invalid?",
        status,
        severity,
        wholeFile: true,
      };
      const result = await checker(rule, client, mode).checkSource("src/a.ts", "x".repeat(300));
      expect(result.diagnostics).toEqual([expect.objectContaining({
        code: "incomplete-evaluation",
        level: "warning",
        ruleId: rule.id,
      })]);
      expect(JSON.parse(formatSarif(result)).runs[0].invocations[0].executionSuccessful).toBe(true);
      expect(client.calls).toBe(0);
    }
  });

  it("reports incomplete evaluation even when other candidates were judged", async () => {
    const client = new CountingClient();
    const result = await checker({
      id: "test/mixed",
      question: "Does this violate the invariant?",
      status: "owned",
    }, client).checkSource("src/a.ts", ["const a = 1;", "x".repeat(300), "const b = 2;"].join("\n"));
    expect(result.evaluations.length).toBeGreaterThan(0);
    expect(result.diagnostics.some((item) =>
      item.code === "incomplete-evaluation" && item.level === "error",
    )).toBe(true);
    expect(client.calls).toBeGreaterThan(0);
  });


  it("excludes an oversized AST match containing unless without hiding other oversized matches", async () => {
    const rule: JevCheckRule = {
      id: "test/ast-exemption",
      question: "Does the call violate the invariant?",
      status: "owned",
      severity: "error",
      ast: { pattern: "console.log($A)", contextBefore: 0, contextAfter: 0 },
      unless: "exempt",
    };
    const client = new CountingClient();
    const exempt = 'console.log("' + "x".repeat(150) + "exempt" + "x".repeat(150) + '");';
    const nonExempt = 'console.log("' + "x".repeat(300) + '");';

    const skippedOnly = await checker(rule, client).checkSource("src/a.ts", exempt);
    expect(skippedOnly.diagnostics).toEqual([]);
    expect(skippedOnly.evaluations).toEqual([]);
    expect(client.calls).toBe(0);

    const mixed = await checker(rule, client).checkSource("src/a.ts", [exempt, nonExempt].join("\n"));
    expect(mixed.diagnostics).toEqual([
      expect.objectContaining({
        code: "incomplete-evaluation",
        level: "error",
        message: expect.stringContaining("lines 2-2"),
      }),
    ]);
    expect(client.calls).toBe(0);
  });

  it("excludes an oversized line containing unless without exempting unrelated lines", async () => {
    const rule: JevCheckRule = {
      id: "test/line-exemption",
      question: "Is the source unsafe?",
      status: "owned",
      severity: "error",
      unless: "exempt",
    };
    const client = new CountingClient();
    const exempt = "exempt " + "x".repeat(300);
    const nonExempt = "unsafe " + "x".repeat(300);

    const excludedOnly = await checker(rule, client).checkSource("src/a.ts", exempt);
    expect(excludedOnly.diagnostics).toEqual([]);
    expect(excludedOnly.evaluations).toEqual([]);

    const mixed = await checker(rule, client).checkSource("src/a.ts", [exempt, nonExempt, "const ok = true;"].join("\n"));
    expect(mixed.diagnostics).toEqual([
      expect.objectContaining({
        code: "incomplete-evaluation",
        level: "error",
        message: expect.stringContaining("Line 2 skipped"),
      }),
    ]);
    expect(mixed.evaluations).toHaveLength(1);
    expect(client.requestLengths.every((length) => length <= 256)).toBe(true);
  });

  it("applies oversized-line exclusions inside prefilter windows without hiding a later match", async () => {
    const rule: JevCheckRule = {
      id: "test/prefilter-exemption",
      question: "Is the call unsafe?",
      status: "owned",
      severity: "error",
      prefilter: "publish",
      contextLines: 0,
      unless: "exempt",
    };
    const source = ["publish exempt " + "x".repeat(300), "publish unsafe " + "x".repeat(300)].join("\n");
    const result = await checker(rule, new CountingClient()).checkSource("src/a.ts", source);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "incomplete-evaluation",
        level: "error",
        message: expect.stringContaining("Line 2 skipped"),
      }),
    ]);
  });
});
