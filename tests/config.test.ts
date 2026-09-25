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
