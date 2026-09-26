import { extname } from "node:path";
import {
  Lang,
  kind,
  parse,
  type NapiConfig,
  type SgNode,
} from "@ast-grep/napi";
import type {
  AstCandidateConfig,
  AstLanguage,
  AstSelector,
  Candidate,
  Diagnostic,
} from "./types.js";

type Matcher = string | number | NapiConfig;

const EXPLICIT_LANGUAGES: Record<AstLanguage, Lang> = {
  javascript: Lang.JavaScript,
  typescript: Lang.TypeScript,
  tsx: Lang.Tsx,
  html: Lang.Html,
  css: Lang.Css,
};

const EXTENSION_LANGUAGES: Record<string, Lang> = {
  ".js": Lang.JavaScript,
  ".mjs": Lang.JavaScript,
  ".cjs": Lang.JavaScript,
  ".jsx": Lang.Tsx,
  ".ts": Lang.TypeScript,
  ".mts": Lang.TypeScript,
  ".cts": Lang.TypeScript,
  ".tsx": Lang.Tsx,
  ".html": Lang.Html,
  ".htm": Lang.Html,
  ".css": Lang.Css,
};

function resolveLanguage(path: string, config: AstCandidateConfig): Lang | undefined {
  if (config.language) return EXPLICIT_LANGUAGES[config.language];
  return EXTENSION_LANGUAGES[extname(path).toLowerCase()];
}

function matcherFor(selector: AstSelector, language: Lang): Matcher {
  if (selector.pattern !== undefined) return selector.pattern;
  if (selector.kind !== undefined) return kind(language, selector.kind);
  return { rule: selector.rule as NapiConfig["rule"] };
}

function nodeMatches(node: SgNode, selector: AstSelector, language: Lang): boolean {
  return node.matches(matcherFor(selector, language));
}

function utf16Column(line: string, byteColumn: number): number {
  const prefix = Buffer.from(line, "utf8").subarray(0, byteColumn).toString("utf8");
  return prefix.length + 1;
}

function normalizedEnd(
  range: ReturnType<SgNode["range"]>,
  lines: string[],
): { line: number; column: number } {
  if (range.end.column === 0 && range.end.line > range.start.line) {
    const line = range.end.line - 1;
    return { line, column: (lines[line]?.length ?? 0) + 1 };
  }
  return {
    line: range.end.line,
    column: utf16Column(lines[range.end.line] ?? "", range.end.column),
  };
}

function rangeSize(lines: string[], start: number, end: number): number {
  if (end < start) return 0;
  let size = end - start;
  for (let index = start; index <= end; index += 1) size += lines[index]?.length ?? 0;
  return size;
}

function boundedContext(
  lines: string[],
  desiredStart: number,
  desiredEnd: number,
  focusStart: number,
  focusEnd: number,
  maxChars: number,
): { start: number; end: number } | undefined {
  let size = rangeSize(lines, focusStart, focusEnd);
  if (size > maxChars) return undefined;

  let start = focusStart;
  let end = focusEnd;

  while (start > desiredStart || end < desiredEnd) {
    let changed = false;
    if (start > desiredStart) {
      const extra = (lines[start - 1]?.length ?? 0) + 1;
      if (size + extra <= maxChars) {
        start -= 1;
        size += extra;
        changed = true;
      }
    }
    if (end < desiredEnd) {
      const extra = (lines[end + 1]?.length ?? 0) + 1;
      if (size + extra <= maxChars) {
        end += 1;
        size += extra;
        changed = true;
      }
    }
    if (!changed) break;
  }

  return { start, end };
}

function contextNodeFor(match: SgNode, config: AstCandidateConfig, language: Lang): SgNode {
  const ancestor = config.context?.ancestor;
  if (!ancestor) return match;
  return match.ancestors().find((node) => nodeMatches(node, ancestor, language)) ?? match;
}

export function validateAstCandidate(config: AstCandidateConfig): void {
  if (!config.language) return;
  const language = EXPLICIT_LANGUAGES[config.language];
  try {
    const root = parse(language, "").root();
    root.findAll(matcherFor(config, language));
    if (config.context?.ancestor) {
      root.findAll(matcherFor(config.context.ancestor, language));
    }
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

export function astCandidates(
  path: string,
  source: string,
  config: AstCandidateConfig,
  maxChars: number,
  ruleId: string,
  defaultContextLines = 0,
): { candidates: Candidate[]; diagnostics: Diagnostic[] } {
  const language = resolveLanguage(path, config);
  if (!language) {
    return {
      candidates: [],
      diagnostics: [{
        level: "warning",
        path,
        ruleId,
        message:
          "AST candidate selection skipped because the file extension has no built-in language mapping; " +
          "set ast.language to javascript, typescript, tsx, html, or css.",
      }],
    };
  }

  const lines = source.split(/\r?\n/);
  const root = parse(language, source).root();
  const matches = root.findAll(matcherFor(config, language));
  const candidates: Candidate[] = [];
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  const before = config.contextBefore ?? defaultContextLines;
  const after = config.contextAfter ?? defaultContextLines;

  for (const node of matches) {
    const range = node.range();
    const identity = [range.start.line, range.start.column, range.end.line, range.end.column].join(":");
    if (seen.has(identity)) continue;
    seen.add(identity);

    const end = normalizedEnd(range, lines);
    const focusStart = range.start.line;
    const focusEnd = end.line;
    const related = contextNodeFor(node, config, language);
    const relatedRange = related.range();
    const relatedEnd = normalizedEnd(relatedRange, lines);
    const desiredStart = Math.max(0, relatedRange.start.line - before);
    const desiredEnd = Math.min(lines.length - 1, relatedEnd.line + after);
    const context = boundedContext(
      lines,
      desiredStart,
      desiredEnd,
      focusStart,
      focusEnd,
      maxChars,
    );

    if (!context) {
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

    candidates.push({
      text: lines.slice(context.start, context.end + 1).join("\n"),
      startLine: context.start + 1,
      endLine: context.end + 1,
      focusStartLine: focusStart + 1,
      focusEndLine: focusEnd + 1,
      focusStartColumn: utf16Column(lines[focusStart] ?? "", range.start.column),
      focusEndColumn: end.column,
      focusKind: String(node.kind()),
    });
  }

  return { candidates, diagnostics };
}
