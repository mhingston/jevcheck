import { extname } from "node:path";
import {
  Lang,
  kind,
  parse,
  type NapiConfig,
  type SgNode,
} from "@ast-grep/napi";
import { AST_LANGUAGES, inferredAstLanguage, NativeAstParserError, parserForAstLanguage, type AstLanguage } from "./ast-languages.js";
import type {
  AstCandidateConfig,
  AstSelector,
  Candidate,
  Diagnostic,
} from "./types.js";

type Matcher = string | number | NapiConfig;

interface ResolvedLanguage {
  name: AstLanguage;
  parser: Lang | string;
}

function resolveLanguage(path: string, config: AstCandidateConfig): ResolvedLanguage | undefined {
  const name: AstLanguage | undefined = config.language ?? inferredAstLanguage(path);
  return name ? { name, parser: parserForAstLanguage(name) } : undefined;
}

function matcherFor(selector: AstSelector, language: Lang | string): Matcher {
  if (selector.pattern !== undefined) return selector.pattern;
  if (selector.kind !== undefined) {
    const id = kind(language, selector.kind);
    // Tree-sitter may return zero rather than throw for an unknown node kind.
    if (!id) throw new Error("Unknown AST node kind '" + selector.kind + "' for language " + language);
    return id;
  }
  return { rule: selector.rule as NapiConfig["rule"] };
}

function nodeMatches(node: SgNode, selector: AstSelector, language: Lang | string): boolean {
  return node.matches(matcherFor(selector, language));
}

function oneBasedColumn(column: number): number {
  return column + 1;
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
    column: oneBasedColumn(range.end.column),
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

function contextNodeFor(match: SgNode, config: AstCandidateConfig, language: Lang | string): SgNode {
  const ancestor = config.context?.ancestor;
  if (!ancestor) return match;
  return match.ancestors().find((node) => nodeMatches(node, ancestor, language)) ?? match;
}

function validateAstSelectors(config: AstCandidateConfig, language: Lang | string): void {
  // Validate against the effective grammar, not just an explicitly configured
  // language. Empty-source matching also rejects malformed ast-grep rule objects.
  const root = parse(language, "").root();
  root.findAll(matcherFor(config, language));
  if (config.context?.ancestor) {
    root.findAll(matcherFor(config.context.ancestor, language));
  }
}

export function validateAstCandidate(config: AstCandidateConfig): void {
  // Language-less rules are validated against each file's inferred grammar.
  if (config.language) {
    validateAstSelectors(config, parserForAstLanguage(config.language));
  }
}

export function astCandidates(
  path: string,
  source: string,
  config: AstCandidateConfig,
  maxChars: number,
  ruleId: string,
  defaultContextLines = 0,
  excludedOversizedMatch?: RegExp,
  prefilter?: RegExp,
): { candidates: Candidate[]; diagnostics: Diagnostic[] } {
  const candidates: Candidate[] = [];
  const diagnostics: Diagnostic[] = [];
  let resolved: ResolvedLanguage | undefined;
  try {
    resolved = resolveLanguage(path, config);
  } catch (error) {
    // A missing native grammar is a hard evaluation error, never a no-match.
    // Return it as a diagnostic so the CLI can still report other files.
    return {
      candidates,
      diagnostics: [{
        code: "incomplete-evaluation",
        level: error instanceof NativeAstParserError ? "error" : "warning",
        path,
        ruleId,
        message:
          "AST language resolution failed for language '" +
          (config.language ?? inferredAstLanguage(path) ?? "unknown") + "': " +
          (error instanceof Error ? error.message : String(error)),
      }],
    };
  }

  if (!resolved) {
    return {
      candidates,
      diagnostics: [{
        code: "incomplete-evaluation",
        level: "warning",
        path,
        ruleId,
        message:
          "No built-in AST language mapping for extension '" +
          (extname(path).toLowerCase() || "(none)") +
          "'; AST rule '" + ruleId + "' was not evaluated for " + path + ". " +
          "Restrict rule.files/exclude to supported extensions, remove ast for text/chunk selection, " +
          "or set ast.language only if the file syntax matches a supported grammar (" +
          AST_LANGUAGES.join(", ") + ").",
      }],
    };
  }

  const { name, parser } = resolved;
  let stage = "selector validation";
  try {
    // Run this even when the source prefilter misses, otherwise a broken
    // selector can silently pass as a legitimate zero-candidate check.
    validateAstSelectors(config, parser);
    if (prefilter && !prefilter.test(source)) return { candidates, diagnostics };

    stage = "source parsing";
    const root = parse(parser, source).root();
    stage = "candidate matching";
    const matches = root.findAll(matcherFor(config, parser));

    const lines = source.split(/\r?\n/);
    const seen = new Set<string>();
    const before = config.contextBefore ?? defaultContextLines;
    const after = config.contextAfter ?? defaultContextLines;

    stage = "match context extraction";
    for (const node of matches) {
      const range = node.range();
      const identity = [range.start.line, range.start.column, range.end.line, range.end.column].join(":");
      if (seen.has(identity)) continue;
      seen.add(identity);

      const end = normalizedEnd(range, lines);
      const focusStart = range.start.line;
      const focusEnd = end.line;
      const related = contextNodeFor(node, config, parser);
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
        // Evaluate an exclusion against this matched node, not the whole file:
        // a different exempt call must not conceal an oversized unsafe match.
        if (excludedOversizedMatch?.test(node.text())) continue;
        diagnostics.push({
          code: "incomplete-evaluation",
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
        focusStartColumn: oneBasedColumn(range.start.column),
        focusEndColumn: end.column,
        focusKind: String(node.kind()),
      });
    }
  } catch (error) {
    diagnostics.push({
      code: "incomplete-evaluation",
      level: error instanceof NativeAstParserError ? "error" : "warning",
      path,
      ruleId,
      message:
        "AST " + stage + " failed for language '" + name + "': " +
        (error instanceof Error ? error.message : String(error)),
    });
  }

  return { candidates, diagnostics };
}
