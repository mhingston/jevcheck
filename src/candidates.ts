import { astCandidates } from "./ast.js";
import type { Candidate, Diagnostic, JevCheckRule } from "./types.js";

export interface CandidateOptions {
  chunkChars: number;
  overlapLines: number;
  contextLines: number;
}

export interface CandidateResult {
  candidates: Candidate[];
  diagnostics: Diagnostic[];
}

interface ChunkResult {
  candidates: Candidate[];
  skippedLines: number[];
}

function regexParts(pattern: string): { source: string; flags: string } {
  if (pattern.startsWith("/")) {
    const lastSlash = pattern.lastIndexOf("/");
    if (lastSlash > 0) {
      return { source: pattern.slice(1, lastSlash), flags: pattern.slice(lastSlash + 1) };
    }
  }
  return { source: pattern, flags: "" };
}

export function compilePattern(pattern: string, global = false): RegExp {
  const parsed = regexParts(pattern);
  const flags = new Set(parsed.flags.split("").filter(Boolean));
  flags.add("m");
  if (global) flags.add("g");
  else flags.delete("g");
  return new RegExp(parsed.source, Array.from(flags).join(""));
}

function lineChunksDetailed(
  lines: string[],
  maxChars: number,
  overlapLines: number,
  baseLine: number,
): ChunkResult {
  if (!lines.length) return { candidates: [], skippedLines: [] };

  const candidates: Candidate[] = [];
  const skippedLines: number[] = [];
  let start = 0;

  while (start < lines.length) {
    if (lines[start].length > maxChars) {
      skippedLines.push(baseLine + start);
      start += 1;
      continue;
    }

    let end = start;
    let size = 0;
    while (end < lines.length) {
      if (lines[end].length > maxChars) break;
      const nextSize = size + (end > start ? 1 : 0) + lines[end].length;
      if (nextSize > maxChars) break;
      size = nextSize;
      end += 1;
    }

    const focusStart = start;
    const focusEnd = end - 1;
    let contextStart = focusStart;
    let contextEnd = focusEnd;
    let contextSize = size;

    for (let count = 0; count < overlapLines && contextStart > 0; count += 1) {
      const previous = contextStart - 1;
      if (lines[previous].length > maxChars) break;
      const extra = lines[previous].length + 1;
      if (contextSize + extra > maxChars) break;
      contextStart = previous;
      contextSize += extra;
    }

    for (let count = 0; count < overlapLines && contextEnd + 1 < lines.length; count += 1) {
      const next = contextEnd + 1;
      if (lines[next].length > maxChars) break;
      const extra = lines[next].length + 1;
      if (contextSize + extra > maxChars) break;
      contextEnd = next;
      contextSize += extra;
    }

    candidates.push({
      text: lines.slice(contextStart, contextEnd + 1).join("\n"),
      startLine: baseLine + contextStart,
      endLine: baseLine + contextEnd,
      focusStartLine: baseLine + focusStart,
      focusEndLine: baseLine + focusEnd,
    });

    start = end;
  }

  return { candidates, skippedLines };
}

export function chunkSource(source: string, maxChars: number, overlapLines: number, baseLine = 1): Candidate[] {
  return lineChunksDetailed(source.split(/\r?\n/), maxChars, overlapLines, baseLine).candidates;
}

function lineForIndex(source: string, index: number): number {
  let line = 0;
  for (let i = 0; i < index; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function mergeWindows(windows: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = [...windows].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];

  for (const window of sorted) {
    const previous = merged.at(-1);
    if (previous && window.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, window.end);
    } else {
      merged.push({ ...window });
    }
  }

  return merged;
}

function prefilterWindows(source: string, pattern: string, contextLines: number): Array<{ start: number; end: number }> {
  const lines = source.split(/\r?\n/);
  const regex = compilePattern(pattern, true);
  const windows: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(source)) !== null) {
    const line = lineForIndex(source, match.index);
    windows.push({
      start: Math.max(0, line - contextLines),
      end: Math.min(lines.length - 1, line + contextLines),
    });
    if (match[0].length === 0) regex.lastIndex += 1;
  }

  return mergeWindows(windows);
}

function appendOversizedLineDiagnostics(
  diagnostics: Diagnostic[],
  path: string,
  ruleId: string,
  skippedLines: number[],
  maxChars: number,
): void {
  for (const line of skippedLines) {
    diagnostics.push({
      level: "warning",
      path,
      ruleId,
      message:
        "Line " +
        line +
        " skipped because it exceeds chunkChars (" +
        maxChars +
        "); jevcheck will not send an oversized semantic request.",
    });
  }
}

function applyCandidateFilters(candidates: Candidate[], rule: JevCheckRule): Candidate[] {
  let filtered = candidates;
  if (rule.prefilter) {
    const prefilter = compilePattern(rule.prefilter);
    filtered = filtered.filter((candidate) => prefilter.test(candidate.text));
  }
  if (rule.unless) {
    const unless = compilePattern(rule.unless);
    filtered = filtered.filter((candidate) => !unless.test(candidate.text));
  }
  return filtered;
}

export function buildCandidates(
  path: string,
  source: string,
  rule: JevCheckRule,
  options: CandidateOptions,
): CandidateResult {
  const diagnostics: Diagnostic[] = [];
  const prefilter = rule.prefilter ? compilePattern(rule.prefilter) : undefined;

  if (rule.wholeFile) {
    if (prefilter && !prefilter.test(source)) return { candidates: [], diagnostics };
    if (source.length > options.chunkChars) {
      diagnostics.push({
        level: "warning",
        path,
        ruleId: rule.id,
        message:
          "Whole-file rule skipped because the file exceeds chunkChars; increase the bound explicitly rather than judging a truncated file.",
      });
      return { candidates: [], diagnostics };
    }

    const lineCount = source.split(/\r?\n/).length;
    const candidate = {
      text: source,
      startLine: 1,
      endLine: lineCount,
      focusStartLine: 1,
      focusEndLine: lineCount,
    };
    if (rule.unless && compilePattern(rule.unless).test(candidate.text)) return { candidates: [], diagnostics };
    return { candidates: [candidate], diagnostics };
  }

  if (rule.ast) {
    const ast = astCandidates(path, source, rule.ast, options.chunkChars, rule.id);
    return {
      candidates: applyCandidateFilters(ast.candidates, rule),
      diagnostics: ast.diagnostics,
    };
  }

  let candidates: Candidate[];
  if (rule.prefilter) {
    const lines = source.split(/\r?\n/);
    const windows = prefilterWindows(source, rule.prefilter, rule.contextLines ?? options.contextLines);
    const chunked = windows.map((window) => {
      const selected = lines.slice(window.start, window.end + 1);
      return lineChunksDetailed(selected, options.chunkChars, options.overlapLines, window.start + 1);
    });
    candidates = chunked.flatMap((item) => item.candidates);
    appendOversizedLineDiagnostics(
      diagnostics,
      path,
      rule.id,
      chunked.flatMap((item) => item.skippedLines),
      options.chunkChars,
    );
  } else {
    const chunked = lineChunksDetailed(source.split(/\r?\n/), options.chunkChars, options.overlapLines, 1);
    candidates = chunked.candidates;
    appendOversizedLineDiagnostics(diagnostics, path, rule.id, chunked.skippedLines, options.chunkChars);
  }

  if (rule.unless) {
    const unless = compilePattern(rule.unless);
    candidates = candidates.filter((candidate) => !unless.test(candidate.text));
  }

  return { candidates, diagnostics };
}
