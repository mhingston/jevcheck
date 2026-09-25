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
  return new RegExp(parsed.source, Array.from(flags).join(""));
}

function lineChunks(lines: string[], maxChars: number, overlapLines: number, baseLine: number): Candidate[] {
  if (!lines.length) return [];
  const chunks: Candidate[] = [];
  let start = 0;

  while (start < lines.length) {
    let end = start;
    let size = 0;
    while (end < lines.length) {
      const nextSize = size + lines[end].length + 1;
      if (end > start && nextSize > maxChars) break;
      size = nextSize;
      end += 1;
    }

    chunks.push({
      text: lines.slice(start, end).join("\n"),
      startLine: baseLine + start,
      endLine: baseLine + end - 1,
    });

    if (end >= lines.length) break;
    start = Math.max(start + 1, end - overlapLines);
  }

  return chunks;
}

export function chunkSource(source: string, maxChars: number, overlapLines: number, baseLine = 1): Candidate[] {
  return lineChunks(source.split(/\r?\n/), maxChars, overlapLines, baseLine);
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
        message: "Whole-file rule skipped because the file exceeds chunkChars; increase the bound explicitly rather than judging a truncated file.",
      });
      return { candidates: [], diagnostics };
    }

    const candidate = { text: source, startLine: 1, endLine: source.split(/\r?\n/).length };
    if (rule.unless && compilePattern(rule.unless).test(candidate.text)) return { candidates: [], diagnostics };
    return { candidates: [candidate], diagnostics };
  }

  let candidates: Candidate[];
  if (rule.prefilter) {
    const lines = source.split(/\r?\n/);
    const windows = prefilterWindows(source, rule.prefilter, rule.contextLines ?? options.contextLines);
    candidates = windows.flatMap((window) => {
      const text = lines.slice(window.start, window.end + 1).join("\n");
      return chunkSource(text, options.chunkChars, options.overlapLines, window.start + 1);
    });
  } else {
    candidates = chunkSource(source, options.chunkChars, options.overlapLines);
  }

  if (rule.unless) {
    const unless = compilePattern(rule.unless);
    candidates = candidates.filter((candidate) => !unless.test(candidate.text));
  }

  return { candidates, diagnostics };
}
