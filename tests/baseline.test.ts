import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  baselineScopeKey,
  findingFingerprint,
  inlineSuppressionReason,
  readBaseline,
  writeBaseline,
} from "../src/baseline.js";

describe("baseline", () => {
  it("preserves fingerprints across unrelated edits outside the finding range", () => {
    const before = ["const unrelated = 1;", "console.log(secret);"].join("\n");
    const after = ["const unrelated = 2;", "console.log(secret);"].join("\n");

    expect(findingFingerprint("security/no-log", "src/a.ts", before, 2, 2, 0)).toBe(
      findingFingerprint("security/no-log", "src/a.ts", after, 2, 2, 0),
    );
  });

  it("distinguishes identical finding occurrences in the same file", () => {
    const source = [
      "console.log(secret);",
      "const unrelated = 1;",
      "console.log(secret);",
    ].join("\n");

    const first = findingFingerprint("security/no-log", "src/a.ts", source, 1, 1, 0);
    const second = findingFingerprint("security/no-log", "src/a.ts", source, 3, 3, 1);
    expect(first).not.toBe(second);
  });

  it("requires a reason and binds suppression only to the finding start", () => {
    const withReason = [
      "// jevcheck-ignore security/no-log -- value is redacted upstream",
      "console.log(secret);",
    ].join("\n");
    const tooFarInsideRange = [
      "function example() {",
      "  const a = 1;",
      "  // jevcheck-ignore security/no-log -- unrelated nested comment",
      "  console.log(secret);",
      "}",
    ].join("\n");

    expect(inlineSuppressionReason(withReason, "security/no-log", 2)).toBe("value is redacted upstream");
    expect(inlineSuppressionReason(tooFarInsideRange, "security/no-log", 1)).toBeUndefined();
  });

  it("preserves baseline entries for rule/path pairs not evaluated by a partial run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-baseline-"));
    const path = join(cwd, "baseline.json");
    await writeBaseline(
      path,
      new Set([
        baselineScopeKey("rule/a", "src/a.ts"),
        baselineScopeKey("rule/b", "src/b.ts"),
      ]),
      [
        { ruleId: "rule/a", path: "src/a.ts", fingerprint: "old-a" },
        { ruleId: "rule/b", path: "src/b.ts", fingerprint: "keep-b" },
      ],
    );
    await writeBaseline(
      path,
      new Set([baselineScopeKey("rule/a", "src/a.ts")]),
      [{ ruleId: "rule/a", path: "src/a.ts", fingerprint: "new-a" }],
    );

    const entries = await readBaseline(path);
    expect(entries).toContainEqual({ ruleId: "rule/a", path: "src/a.ts", fingerprint: "new-a" });
    expect(entries).toContainEqual({ ruleId: "rule/b", path: "src/b.ts", fingerprint: "keep-b" });
    expect(await readFile(path, "utf8")).toContain("new-a");
  });
});
