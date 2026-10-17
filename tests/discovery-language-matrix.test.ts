import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inferredAstLanguage, parserForAstLanguage, type AstLanguage } from "../src/ast-languages.js";
import { buildCandidates } from "../src/candidates.js";
import { createJevCheck } from "../src/engine.js";
import { DEFAULT_SOURCE_INCLUDE } from "../src/evidence-store.js";
import { discoverFiles } from "../src/files.js";
import type { JevCheckRule } from "../src/types.js";

// Each row is an extension documented in the README/reference/skill matrix.
// These are independent fixtures: adding a grammar must not silently change
// the default discovery set, or vice versa.
const matrix: Array<{ extension: string; language?: AstLanguage }> = [
  { extension: "js", language: "javascript" },
  { extension: "mjs", language: "javascript" },
  { extension: "cjs", language: "javascript" },
  { extension: "ts", language: "typescript" },
  { extension: "mts", language: "typescript" },
  { extension: "cts", language: "typescript" },
  { extension: "jsx", language: "tsx" },
  { extension: "tsx", language: "tsx" },
  { extension: "html", language: "html" },
  { extension: "htm", language: "html" },
  { extension: "css", language: "css" },
  { extension: "cs", language: "csharp" },
  { extension: "py", language: "python" },
  { extension: "go", language: "go" },
  { extension: "java", language: "java" },
  { extension: "rs", language: "rust" },
  { extension: "rb" },
  { extension: "php" },
  { extension: "vue" },
  { extension: "svelte" },
];

const options = { chunkChars: 6000, overlapLines: 0, contextLines: 0 };
const source = "value = 1;\n";

describe("documented source discovery and AST language matrix", () => {
  it("discovers every documented default extension, excluding other file types", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-discovery-matrix-"));
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      for (const { extension } of matrix) {
        await writeFile(join(cwd, "src", "sample." + extension), source);
      }
      await writeFile(join(cwd, "src", "not-default.md"), source);
      await writeFile(join(cwd, "src", "not-default.json"), source);

      const discovered = await discoverFiles(DEFAULT_SOURCE_INCLUDE, [], cwd);
      expect(discovered).toEqual(matrix.map(({ extension }) => "src/sample." + extension).sort());
      expect(await discoverFiles(["src/**/*.md"], [], cwd)).toEqual(["src/not-default.md"]);
      expect(await discoverFiles(DEFAULT_SOURCE_INCLUDE, ["**/*.css"], cwd))
        .not.toContain("src/sample.css");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it.each(matrix)("infers AST support and allows text/chunk candidates for .$extension", ({ extension, language }) => {
    const path = "src/sample." + extension;
    expect(inferredAstLanguage(path)).toBe(language);
    expect(inferredAstLanguage(path.toUpperCase())).toBe(language);
    if (language) expect(parserForAstLanguage(language)).toBeTruthy();
    const text = buildCandidates(path, source, {
      id: "matrix/text",
      question: "Is this unsafe?",
    }, options);
    expect(text.diagnostics).toEqual([]);
    expect(text.candidates).toHaveLength(1);
  });

  it.each(matrix.filter(({ language }) => !language))(
    "reports a remediable incomplete AST evaluation for .$extension",
    ({ extension }) => {
      const path = "src/sample." + extension;
      const result = buildCandidates(path, source, {
        id: "matrix/unsupported",
        question: "Is this unsafe?",
        ast: { pattern: "value = $A" },
      }, options);
      expect(result.candidates).toEqual([]);
      expect(result.diagnostics).toEqual([expect.objectContaining({
        code: "incomplete-evaluation",
        level: "warning",
        ruleId: "matrix/unsupported",
        path,
        message: expect.stringContaining("extension '." + extension + "'"),
      })]);
      expect(result.diagnostics[0]?.message).toContain("remove ast for text/chunk selection");
      expect(result.diagnostics[0]?.message).toContain("rule.files/exclude");
    },
  );

  it("allows an explicit compatible grammar without treating file extension as the parser", () => {
    const result = buildCandidates("src/pure-js-snippet.vue", "console.log(secret);", {
      id: "matrix/override",
      question: "Is this unsafe?",
      ast: { language: "javascript", pattern: "console.log($A)" },
    }, options);
    expect(result.diagnostics).toEqual([]);
    expect(result.candidates).toHaveLength(1);
  });

  it("never silently passes discovered unsupported files for an owned AST error rule", async () => {
    const rule: JevCheckRule = {
      id: "matrix/owned",
      question: "Is this unsafe?",
      status: "owned",
      severity: "error",
      ast: { pattern: "value = $A" },
    };
    const checker = createJevCheck({
      rules: [rule],
      client: { async systemOne() { throw new Error("unexpected provider call"); } },
      ruleEvidenceReports: [{
        ruleId: rule.id,
        currentStatus: "owned",
        checks: [],
        blockers: [],
        warnings: [],
        readyForOwned: true,
      }],
    });
    const unsupported = matrix.filter(({ language }) => !language);
    const result = await checker.checkSources(unsupported.map(({ extension }) => ({
      path: "src/sample." + extension,
      source,
    })));
    expect(result.findings).toEqual([]);
    expect(result.evaluations).toEqual([]);
    expect(result.diagnostics).toHaveLength(unsupported.length);
    expect(result.diagnostics.map(({ path }) => path).sort())
      .toEqual(unsupported.map(({ extension }) => "src/sample." + extension).sort());
    expect(result.diagnostics.every(({ code, level }) =>
      code === "incomplete-evaluation" && level === "error")).toBe(true);
  });
});
