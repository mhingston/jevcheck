import { describe, expect, it } from "vitest";
import { applyMutation, stableMutationOrder } from "../src/mutate.js";

describe("mutation helpers", () => {
  it("applies one replacement by default and all replacements when requested", () => {
    const source = "redacted redacted";

    expect(applyMutation(source, {
      id: "one",
      pattern: "/redacted/",
      replacement: "secret",
    })).toBe("secret redacted");

    expect(applyMutation(source, {
      id: "all",
      pattern: "/redacted/",
      replacement: "secret",
      replaceAll: true,
    })).toBe("secret secret");
  });

  it("returns undefined when a mutation does not change the file", () => {
    expect(applyMutation("const x = 1;", {
      id: "missing",
      pattern: "/redacted/",
      replacement: "secret",
    })).toBeUndefined();
  });

  it("produces stable path ordering keys", () => {
    expect(stableMutationOrder("rule", "mutant", "src\\a.ts"))
      .toBe(stableMutationOrder("rule", "mutant", "src/a.ts"));
    expect(stableMutationOrder("rule", "mutant", "src/a.ts"))
      .not.toBe(stableMutationOrder("rule", "mutant", "src/b.ts"));
  });
});
