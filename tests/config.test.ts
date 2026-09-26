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
});
