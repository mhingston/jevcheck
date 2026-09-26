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
    expect(() =>
      parseConfig({
        driftThreshold: 1.1,
        rules: [{ id: "example", question: "Is this a violation?" }],
      }),
    ).toThrow("driftThreshold must be between 0 and 1");
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
