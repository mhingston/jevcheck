import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { inspectSource } from "../src/inspect.js";

const question = "Can this handler acknowledge failed publication?";

function rule(extra: Record<string, unknown>) {
  return { id: "reliability/queue-ack", question, ...extra };
}

describe("JSON configuration shorthands", () => {
  it("normalizes AST kinds and literal filters to canonical rules", () => {
    const simple = parseConfig({
      include: ["src/**/*.ts"],
      rules: [rule({ ast: "function_declaration", contains: "queue.publish(" })],
    });
    const canonical = parseConfig({
      include: ["src/**/*.ts"],
      rules: [rule({ ast: { kind: "function_declaration" }, prefilter: "queue\\.publish\\(" })],
    });

    expect(simple).toEqual(canonical);
    expect(simple.rules[0]).not.toHaveProperty("contains");
    const input = { path: "src/handler.ts", source: "function handler() { queue.publish(job); }" };
    const simplified = inspectSource(input, simple.rules);
    const verbose = inspectSource(input, canonical.rules);
    expect(simplified.inspections).toHaveLength(1);
    expect(simplified.inspections[0]?.semanticKey).toBe(verbose.inspections[0]?.semanticKey);
  });

  it("matches punctuation literally, not as regular expression syntax", () => {
    const config = parseConfig({
      rules: [rule({ ast: "function_declaration", contains: "queue.publish(" })],
    });
    const inspected = inspectSource({
      path: "src/handler.ts",
      source: "function correct() { queue.publish(job); }\nfunction other() { queueXpublish(job); }",
    }, config.rules);
    expect(inspected.inspections).toHaveLength(1);
    expect(inspected.inspections[0]?.focusLineRange[0]).toBe(1);
  });

  it("escapes a leading slash rather than interpreting regex delimiter syntax", () => {
    const config = parseConfig({
      rules: [rule({ wholeFile: true, contains: "/route(" })],
    });
    expect(config.rules[0]?.prefilter).toBe("\\/route\\(");
    expect(inspectSource({ path: "src/a.ts", source: 'const x = "/route(";'}, config.rules).inspections).toHaveLength(1);
    expect(inspectSource({ path: "src/a.ts", source: 'const x = "/routeX";'}, config.rules).inspections).toHaveLength(0);
  });

  it("rejects ambiguous or invalid shorthand rather than silently changing scope", () => {
    expect(() => parseConfig({ rules: [rule({ contains: "" })] }))
      .toThrow("reliability/queue-ack.contains must be a non-empty string");
    expect(() => parseConfig({ rules: [rule({ contains: "foo", prefilter: "bar" })] }))
      .toThrow("cannot use contains and prefilter together");
    expect(() => parseConfig({ rules: [rule({ ast: "  " })] }))
      .toThrow("reliability/queue-ack.ast must be a non-empty string");
    expect(() => parseConfig({ rules: [rule({ ast: "function_declaration", wholeFile: true })] }))
      .toThrow("cannot use ast and wholeFile together");
    expect(() => parseConfig({ rules: [rule({ ast: 42 })] }))
      .toThrow("ast must be an object");
  });
});
