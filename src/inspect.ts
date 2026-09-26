import {
  DEFAULT_CHUNK_CHARS,
  DEFAULT_CONTEXT_LINES,
  DEFAULT_OVERLAP_LINES,
  ruleAppliesToFile,
} from "./engine.js";
import { buildCandidates } from "./candidates.js";
import { semanticRequestForCandidate } from "./semantic.js";
import type { Diagnostic, JevCheckRule, SourceInput } from "./types.js";

export interface InspectOptions {
  chunkChars?: number;
  overlapLines?: number;
  contextLines?: number;
}

export interface SemanticInspection {
  ruleId: string;
  path: string;
  selector: string;
  range: [number, number];
  focusLineRange: [number, number];
  focusRange?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  focusKind?: string;
  semanticKey: string;
  estimatedRequestChars: number;
  request: ReturnType<typeof semanticRequestForCandidate>;
}

export interface InspectResult {
  inspections: SemanticInspection[];
  diagnostics: Diagnostic[];
}

function selectorDescription(rule: JevCheckRule): string {
  if (rule.ast) {
    if ("pattern" in rule.ast && rule.ast.pattern) return "ast pattern: " + rule.ast.pattern;
    if ("kind" in rule.ast && rule.ast.kind) return "ast kind: " + rule.ast.kind;
    return "ast rule";
  }
  if (rule.wholeFile) return "whole file";
  if (rule.prefilter) return "prefilter: " + rule.prefilter;
  return "bounded chunks";
}

export function inspectSource(
  input: SourceInput,
  rules: readonly JevCheckRule[],
  options: InspectOptions = {},
): InspectResult {
  const inspections: SemanticInspection[] = [];
  const diagnostics: Diagnostic[] = [];
  const candidateOptions = {
    chunkChars: options.chunkChars ?? DEFAULT_CHUNK_CHARS,
    overlapLines: options.overlapLines ?? DEFAULT_OVERLAP_LINES,
    contextLines: options.contextLines ?? DEFAULT_CONTEXT_LINES,
  };

  for (const rule of rules) {
    if (!ruleAppliesToFile(rule, input.path)) continue;
    const built = buildCandidates(input.path, input.source, rule, candidateOptions);
    diagnostics.push(...built.diagnostics);

    for (const candidate of built.candidates) {
      const request = semanticRequestForCandidate(rule, input.path, candidate);
      const serialized = JSON.stringify({ state: request.state, question: request.question });
      inspections.push({
        ruleId: rule.id,
        path: input.path,
        selector: selectorDescription(rule),
        range: [candidate.startLine, candidate.endLine],
        focusLineRange: [candidate.focusStartLine, candidate.focusEndLine],
        ...(candidate.focusStartColumn !== undefined && candidate.focusEndColumn !== undefined
          ? {
              focusRange: {
                start: {
                  line: candidate.focusStartLine,
                  column: candidate.focusStartColumn,
                },
                end: {
                  line: candidate.focusEndLine,
                  column: candidate.focusEndColumn,
                },
              },
            }
          : {}),
        ...(candidate.focusKind ? { focusKind: candidate.focusKind } : {}),
        semanticKey: request.identity.key,
        estimatedRequestChars: serialized.length,
        request,
      });
    }
  }

  return { inspections, diagnostics };
}

export function inspectSources(
  inputs: readonly SourceInput[],
  rules: readonly JevCheckRule[],
  options: InspectOptions = {},
): InspectResult {
  const result: InspectResult = { inspections: [], diagnostics: [] };
  for (const input of inputs) {
    const inspected = inspectSource(input, rules, options);
    result.inspections.push(...inspected.inspections);
    result.diagnostics.push(...inspected.diagnostics);
  }
  return result;
}

export function formatInspectionStylish(result: InspectResult): string {
  const sections = result.inspections.map((item) => {
    const focus = item.focusRange
      ? item.path + ":" + item.focusRange.start.line + ":" + item.focusRange.start.column +
        "-" + item.focusRange.end.line + ":" + item.focusRange.end.column
      : item.path + ":" + item.focusLineRange[0] + "-" + item.focusLineRange[1];
    return [
      item.ruleId + "  " + focus,
      "  selector: " + item.selector,
      "  context: " + item.range[0] + "-" + item.range[1],
      ...(item.focusKind ? ["  focus kind: " + item.focusKind] : []),
      "  semantic key: " + item.semanticKey,
      "  estimated request chars: " + item.estimatedRequestChars,
      "  exact request:",
      JSON.stringify({ state: item.request.state, question: item.request.question }, null, 2),
    ].join("\n");
  });

  for (const diagnostic of result.diagnostics) {
    sections.push(
      [
        diagnostic.level.toUpperCase() + ": " + diagnostic.message,
        ...(diagnostic.ruleId ? ["  rule: " + diagnostic.ruleId] : []),
        ...(diagnostic.path ? ["  path: " + diagnostic.path] : []),
      ].join("\n"),
    );
  }

  return sections.length ? sections.join("\n\n") : "No semantic candidates matched.";
}
