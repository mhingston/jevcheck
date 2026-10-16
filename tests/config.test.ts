import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("validates nested criteria labels", () => {
    expect(() =>
      parseConfig({
        rules: [{
          id: "example",
          question: "Is this a violation?",
          criteria: { true: 123 },
        }],
      }),
    ).toThrow("example.criteria.true must be a non-empty string");
  });

  it("validates replayFile when configured", () => {
    expect(() =>
      parseConfig({
        replayFile: "",
        rules: [{ id: "example", question: "Is this a violation?" }],
      }),
    ).toThrow("replayFile must be a non-empty string");
  });

  it("validates confirmationFile when configured", () => {
    expect(() =>
      parseConfig({
        confirmationFile: "",
        rules: [{ id: "example", question: "Is this a violation?" }],
      }),
    ).toThrow("confirmationFile must be a non-empty string");
  });

  it("validates calibrationFile when configured", () => {
    expect(() =>
      parseConfig({
        calibrationFile: "",
        rules: [{ id: "example", question: "Is this a violation?" }],
      }),
    ).toThrow("calibrationFile must be a non-empty string");
  });

  it("validates driftThreshold when configured", () => {
    for (const driftThreshold of [1.1, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        parseConfig({
          driftThreshold,
          rules: [{ id: "example", question: "Is this a violation?" }],
        }),
      ).toThrow("driftThreshold must be between 0 and 1");
    }
  });

  it("validates graduation policy", () => {
    for (const minMutationRecall of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        parseConfig({
          graduation: { minMutationRecall },
          rules: [{ id: "example", question: "Is this a violation?" }],
        }),
      ).toThrow("graduation.minMutationRecall must be between 0 and 1");
    }

    expect(() =>
      parseConfig({
        graduation: { requireSource: "yes" },
        rules: [{ id: "example", question: "Is this a violation?" }],
      }),
    ).toThrow("graduation.requireSource must be a boolean");

    expect(() =>
      parseConfig({
        graduation: { magic: true },
        rules: [{ id: "example", question: "Is this a violation?" }],
      }),
    ).toThrow("graduation contains unknown field(s): magic");
  });

  it("validates evidenceFile when configured", () => {
    expect(() =>
      parseConfig({
        evidenceFile: "",
        rules: [{ id: "example", question: "Is this a violation?" }],
      }),
    ).toThrow("evidenceFile must be a non-empty string");
  });

  it("validates declarative mutants", () => {
    expect(() =>
      parseConfig({
        rules: [{
          id: "example",
          question: "Is this a violation?",
          mutants: [],
        }],
      }),
    ).toThrow("example.mutants must be a non-empty array");

    expect(() =>
      parseConfig({
        rules: [{
          id: "example",
          question: "Is this a violation?",
          mutants: [
            { id: "x", pattern: "/a/", replacement: "b" },
            { id: "x", pattern: "/c/", replacement: "d" },
          ],
        }],
      }),
    ).toThrow("example.mutants contains duplicate id: x");

    expect(() =>
      parseConfig({
        rules: [{
          id: "example",
          question: "Is this a violation?",
          mutants: [{ id: "x", pattern: "/[/", replacement: "" }],
        }],
      }),
    ).toThrow("pattern is not a valid regular expression");
  });

  it("validates nested confirmation fixture pattern arrays", () => {
    expect(() =>
      parseConfig({
        rules: [{
          id: "example",
          question: "Is this a violation?",
          fixtures: {
            confirmation: { valid: "fixtures/confirmation/valid/**/*.ts" },
          },
        }],
      }),
    ).toThrow(
      "example.fixtures.confirmation.valid must be an array of non-empty strings",
    );
  });

  it("validates nested fixture pattern arrays", () => {
    expect(() =>
      parseConfig({
        rules: [{
          id: "example",
          question: "Is this a violation?",
          fixtures: { valid: "fixtures/valid/**/*.ts" },
        }],
      }),
    ).toThrow("example.fixtures.valid must be an array of non-empty strings");
  });
  it("validates projectWhen recursively", () => {
    expect(() =>
      parseConfig({
        rules: [{
          id: "example",
          question: "Is this a violation?",
          projectWhen: { fileExists: "../outside" },
        }],
      }),
    ).toThrow("example.projectWhen.fileExists must stay inside the repository");

    expect(() =>
      parseConfig({
        rules: [{
          id: "example",
          question: "Is this a violation?",
          projectWhen: { anyOf: [] },
        }],
      }),
    ).toThrow("example.projectWhen.anyOf must be a non-empty array");

    expect(() =>
      parseConfig({
        rules: [{
          id: "example",
          question: "Is this a violation?",
          projectWhen: { fileExists: "src/a.ts", globMatches: "src/**/*.ts" },
        }],
      }),
    ).toThrow("example.projectWhen must define exactly one project condition");
  });

  it("validates deterministic coverage declarations", () => {
    expect(() =>
      parseConfig({
        rules: [{
          id: "example",
          question: "Is this a violation?",
          coveredBy: [],
        }],
      }),
    ).toThrow("example.coveredBy must be a non-empty array");

    expect(() =>
      parseConfig({
        rules: [{
          id: "example",
          question: "Is this a violation?",
          coveredBy: [
            { id: "test", path: "tests/a.ts" },
            { id: "test", path: "tests/b.ts" },
          ],
        }],
      }),
    ).toThrow("example.coveredBy contains duplicate id: test");

    expect(() =>
      parseConfig({
        rules: [{
          id: "example",
          question: "Is this a violation?",
          coveredBy: [{ id: "test", path: "../outside.ts" }],
        }],
      }),
    ).toThrow("example.coveredBy[0].path must stay inside the repository");
  });


  it("rejects unknown fields with their complete config paths and typo hints", () => {
    const rule = { id: "example", question: "Is this a violation?" };
    const cases: Array<{ config: unknown; message: string }> = [
      {
        config: { incldue: ["src/**/*.ts"], rules: [rule] },
        message: "config.incldue: unknown field (did you mean include?)",
      },
      {
        config: { rules: [{ ...rule, contain: "queue.publish(" }] },
        message: "rules[0].contain: unknown field (did you mean contains?)",
      },
      {
        config: { rules: [{ ...rule, ast: { patttern: "console.log($A)" } }] },
        message: "example.ast.patttern: unknown field (did you mean pattern?)",
      },
      {
        config: { rules: [{
          ...rule, ast: { pattern: "console.log($A)", context: { ancsestor: { kind: "function_declaration" } } },
        }] },
        message: "example.ast.context.ancsestor: unknown field (did you mean ancestor?)",
      },
      {
        config: { rules: [{
          ...rule, ast: { pattern: "console.log($A)", context: { ancestor: { knd: "function_declaration" } } },
        }] },
        message: "example.ast.context.ancestor.knd: unknown field (did you mean kind?)",
      },
      {
        config: { rules: [{ ...rule, criteria: { treu: "This is invalid" } }] },
        message: "rules[0].criteria.treu: unknown field (did you mean true?)",
      },
      {
        config: { rules: [{ ...rule, fixtures: { vaild: ["fixtures/valid.ts"] } }] },
        message: "rules[0].fixtures.vaild: unknown field (did you mean valid?)",
      },
      {
        config: { rules: [{ ...rule, fixtures: { confirmation: { invald: ["fixtures/bad.ts"] } } }] },
        message: "rules[0].fixtures.confirmation.invald: unknown field (did you mean invalid?)",
      },
      {
        config: { rules: [{ ...rule, mutants: [{ id: "m", pattern: "foo", replacement: "bar", replaceAl: true }] }] },
        message: "rules[0].mutants[0].replaceAl: unknown field (did you mean replaceAll?)",
      },
      {
        config: { rules: [{ ...rule, scopeOverride: true }] },
        message: "rules[0].scopeOverride: unknown field",
      },
      {
        config: { rules: [{ ...rule, projectWhen: { fileExits: "src/foo.ts" } }] },
        message: "example.projectWhen contains unknown field(s): fileExits",
      },
      {
        config: { rules: [{ ...rule, coveredBy: [{ id: "unit", path: "tests/a.ts", displayName: "unit" }] }] },
        message: "example.coveredBy[0] contains unknown field(s): displayName",
      },
      {
        config: { rules: [rule], graduation: { requireMutation: false } },
        message: "graduation contains unknown field(s): requireMutation",
      },
    ];
    for (const { config, message } of cases) {
      expect(() => parseConfig(config), message).toThrow(message);
    }
  });

  it("preserves documented shorthand normalization and arbitrary ast-grep composite rules", () => {
    const config = parseConfig({
      rules: [{
        id: "shorthand",
        question: "Is this a violation?",
        contains: "queue.publish(",
        ast: "function_declaration",
      }, {
        id: "composite",
        question: "Is this a violation?",
        ast: {
          rule: {
            all: [
              { kind: "call_expression" },
              { has: { pattern: "publish($A)" } },
            ],
            not: { inside: { kind: "comment" } },
          },
          context: {
            ancestor: { rule: { all: [{ kind: "function_declaration" }] } },
          },
        },
      }],
    });
    expect(config.rules[0]?.prefilter).toBe("queue\\.publish\\(");
    expect(config.rules[0]?.ast).toEqual({ kind: "function_declaration" });
    expect("contains" in config.rules[0]!).toBe(false);
    expect(config.rules[1]?.ast).toMatchObject({
      rule: { all: [{ kind: "call_expression" }, { has: { pattern: "publish($A)" } }] },
      context: { ancestor: { rule: { all: [{ kind: "function_declaration" }] } } },
    });
  });

  it("parses every bundled runnable example config", () => {
    for (const path of [
      "examples/queue-ack/jevcheck.config.json",
      "examples/csharp-queue/jevcheck.config.json",
      "examples/multilanguage-ast/jevcheck.config.json",
    ]) {
      const value = JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")) as unknown;
      expect(parseConfig(value).rules.length, path).toBeGreaterThan(0);
    }
  });
});
