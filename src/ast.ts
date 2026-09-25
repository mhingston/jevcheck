import type { NapiConfig } from "@ast-grep/napi";
import { Lang, parse } from "@ast-grep/napi";
import type { AstCandidateConfig, Candidate, Diagnostic } from "./types.js";

function langFor(language: AstCandidateConfig["language"]): Lang {
  return language === "tsx" ? Lang.Tsx : Lang.TypeScript;
}

function napiConfig(config: AstCandidateConfig): NapiConfig {
  return { rule: config.rule as NapiConfig["rule"] };
}

export function validateAstCandidate(config: AstCandidateConfig): void {
  try {
    parse(langFor(config.language), "").root().findAll(napiConfig(config));
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

function textLength(lines: string[], start: number, end: number): number {
  if (end < start) return 0;
  let length = end - start;
  for (let index = start; index <= end; index += 1) length += lines[index].length;
  return length;
}

export function astCandidates(
  path: string,
  source: string,
  config: AstCandidateConfig,
  maxChars: number,
  ruleId: string,
): { candidates: Candidate[]; diagnostics: Diagnostic[] } {
  const lines = source.split(/\r?\n/);
  const root = parse(langFor(config.language), source).root();
  const matches = root.findAll(napiConfig(config));
  const candidates: Candidate[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const node of matches) {
    const range = node.range();
    const focusStart = range.start.line;
    const focusEnd = range.end.line;
    const focusSize = textLength(lines, focusStart, focusEnd);

    if (focusSize > maxChars) {
      diagnostics.push({
        level: "warning",
        path,
        ruleId,
        message:
          "AST candidate at lines " +
          (focusStart + 1) +
          "-" +
          (focusEnd + 1) +
          " skipped because its matched node exceeds chunkChars (" +
          maxChars +
          ").",
      });
      continue;
    }

    let start = focusStart;
    let end = focusEnd;
    let size = focusSize;
    const before = config.contextBefore ?? 0;
    const after = config.contextAfter ?? 0;

    for (let count = 0; count < before && start > 0; count += 1) {
      const extra = lines[start - 1].length + 1;
      if (size + extra > maxChars) break;
      start -= 1;
      size += extra;
    }

    for (let count = 0; count < after && end + 1 < lines.length; count += 1) {
      const extra = lines[end + 1].length + 1;
      if (size + extra > maxChars) break;
      end += 1;
      size += extra;
    }

    candidates.push({
      text: lines.slice(start, end + 1).join("\n"),
      startLine: start + 1,
      endLine: end + 1,
      focusStartLine: focusStart + 1,
      focusEndLine: focusEnd + 1,
    });
  }

  return { candidates, diagnostics };
}
