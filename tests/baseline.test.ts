import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findingFingerprint,
  inlineSuppressionReason,
  readBaseline,
  writeBaseline,
} from "../src/baseline.js";

describe("baseline", () => {
  it("fingerprints only the finding range so unrelated edits do not invalidate it", () => {
    const before = ["const unrelated = 1;", "console.log(secret);"].join("\n");
    const after = ["const unrelated = 2;", "console.log(secret);"].join("\n");

    expect(findingFingerprint("security/no-log", "src/a.ts", before, 2, 2)).toBe(
      findingFingerprint("security/no-log", "src/a.ts", after, 2, 2),
    );
  });

  it("requires a reason for inline suppression", () => {
    const withReason = [
      "// jevcheck-ignore security/no-log -- value is redacted upstream",
      "console.log(secret);",
    ].join("\n");
    const withoutReason = [
      "// jevcheck-ignore security/no-log",
      "console.log(secret);",
    ].join("\n");

    expect(inlineSuppressionReason(withReason, "security/no-log", 2, 2)).toBe("value is redacted upstream");
    expect(inlineSuppressionReason(withoutReason, "security/no-log", 2, 2)).toBeUndefined();
  });

  it("updates only scanned file and rule baseline entries", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-baseline-"));
    const path = join(cwd, "baseline.json");
    await writeBaseline(
      path,
      new Set(["src/a.ts"]),
      new Set(["rule/a"]),
      [
        { ruleId: "rule/a", path: "src/a.ts", fingerprint: "new" },
        { ruleId: "rule/b", path: "src/b.ts", fingerprint: "keep" },
      ],
    );
    await writeBaseline(
      path,
      new Set(["src/a.ts"]),
      new Set(["rule/a"]),
      [{ ruleId: "rule/a", path: "src/a.ts", fingerprint: "newer" }],
    );

    const entries = await readBaseline(path);
    expect(entries).toContainEqual({ ruleId: "rule/a", path: "src/a.ts", fingerprint: "newer" });
    expect(entries).toContainEqual({ ruleId: "rule/b", path: "src/b.ts", fingerprint: "keep" });
    expect(await readFile(path, "utf8")).toContain("newer");
  });
});
