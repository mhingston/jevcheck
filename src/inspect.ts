import {
  DEFAULT_CHUNK_CHARS,
  DEFAULT_CONTEXT_LINES,
  DEFAULT_OVERLAP_LINES,
} from "./engine.js";
import { isLocalRuleSource } from "./architecture-decision.js";
import { buildCandidates } from "./candidates.js";
import { evaluateConfiguredRuleEvidence } from "./evidence-store.js";
import {
  createRuleExecutionResolver,
  type RuleExecution,
} from "./execution-policy.js";
import { semanticRequestForCandidate } from "./semantic.js";
import type {
  Diagnostic, JevCheckConfig, JevCheckRule, RuleEvidenceReport, SourceInput,
} from "./types.js";

export interface InspectOptions {
  chunkChars?: number;
  overlapLines?: number;
  contextLines?: number;
  /** Optional precomputed reports from the same snapshot used by enforcement. */
  ruleEvidenceReports?: readonly RuleEvidenceReport[];
  /** Used for projectWhen and evidence files when inspecting programmatically. */
  projectRoot?: string;
  /** Full configuration is needed to locate non-default evidence files. */
  config?: JevCheckConfig;
  modelNamespace?: string;
  /** Show candidates for skipped rules, but never imply they would be sent. */
  previewSkipped?: boolean;
}

export interface RuleInspection {
  ruleId: string;
  path: string;
  execution: RuleExecution;
  reason: string;
  selector: string;
  selectorRan: boolean;
  candidateCount: number;
  selectorDiagnostics: Diagnostic[];
}

export interface SemanticInspection {
  ruleId: string;
  path: string;
  execution: RuleExecution;
  reason: string;
  previewOnly: boolean;
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
  rules: RuleInspection[];
  inspections: SemanticInspection[];
  /** Diagnostics from selectors that enforcement would actually execute. */
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

/** Provider-free inspection of the same runtime policy and bounded requests as check. */
export async function inspectSources(
  inputs: readonly SourceInput[],
  rules: readonly JevCheckRule[],
  options: InspectOptions = {},
): Promise<InspectResult> {
  const result: InspectResult = { rules: [], inspections: [], diagnostics: [] };
  // The CLI passes its policy reports explicitly. For library callers, resolve
  // ADR/coverage policy from disk rather than silently treating it as semantic.
  const hasEvidencePolicy = rules.some((rule) =>
    (rule.coveredBy?.length ?? 0) > 0 || isLocalRuleSource(rule.source));
  const reports = options.ruleEvidenceReports ??
    (hasEvidencePolicy
      ? (await evaluateConfiguredRuleEvidence(
          options.config ?? { rules: [...rules] },
          {
            cwd: options.projectRoot ?? process.cwd(),
            modelNamespace: options.modelNamespace ?? "typesafe:default",
          },
        )).reports
      : []);
  const resolveExecution = createRuleExecutionResolver(
    reports, options.projectRoot ?? process.cwd(),
  );
  const candidateOptions = {
    chunkChars: options.chunkChars ?? options.config?.chunkChars ?? DEFAULT_CHUNK_CHARS,
    overlapLines: options.overlapLines ?? options.config?.overlapLines ?? DEFAULT_OVERLAP_LINES,
    contextLines: options.contextLines ?? options.config?.contextLines ?? DEFAULT_CONTEXT_LINES,
  };

  for (const input of inputs) {
    for (const rule of rules) {
      const policy = await resolveExecution(rule, input.path);
      const selector = selectorDescription(rule);
      const selectorRan = policy.execution === "semantic" || options.previewSkipped === true;
      const built = selectorRan
        ? buildCandidates(input.path, input.source, rule, candidateOptions)
        : { candidates: [], diagnostics: [] as Diagnostic[] };
      result.rules.push({
        ruleId: rule.id,
        path: input.path,
        execution: policy.execution,
        reason: policy.reason,
        selector,
        selectorRan,
        candidateCount: built.candidates.length,
        selectorDiagnostics: built.diagnostics,
      });
      if (policy.execution === "semantic") result.diagnostics.push(...built.diagnostics);

      for (const candidate of built.candidates) {
        const request = semanticRequestForCandidate(rule, input.path, candidate);
        const serialized = JSON.stringify({ state: request.state, question: request.question });
        result.inspections.push({
          ruleId: rule.id,
          path: input.path,
          execution: policy.execution,
          reason: policy.reason,
          previewOnly: policy.execution !== "semantic",
          selector,
          range: [candidate.startLine, candidate.endLine],
          focusLineRange: [candidate.focusStartLine, candidate.focusEndLine],
          ...(candidate.focusStartColumn !== undefined && candidate.focusEndColumn !== undefined
            ? {
                focusRange: {
                  start: { line: candidate.focusStartLine, column: candidate.focusStartColumn },
                  end: { line: candidate.focusEndLine, column: candidate.focusEndColumn },
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
  }
  return result;
}

export async function inspectSource(
  input: SourceInput,
  rules: readonly JevCheckRule[],
  options: InspectOptions = {},
): Promise<InspectResult> {
  return inspectSources([input], rules, options);
}

export function formatInspectionStylish(result: InspectResult, verbose = false): string {
  const semantic = result.rules.filter((r) => r.execution === "semantic").length;
  const covered = result.rules.filter((r) => r.execution === "covered").length;
  const inapplicable = result.rules.filter((r) => r.execution === "inapplicable").length;
  const errors = result.diagnostics.filter((d) => d.level === "error").length;
  const lines = [
    (errors ? "BLOCK" : result.diagnostics.length ? "WARN" : "PASS") +
      "  Inspect: " + result.rules.length + " rule/file policies  |  " +
      semantic + " semantic  |  " + covered + " covered  |  " +
      inapplicable + " inapplicable  |  " + result.inspections.length + " candidates",
  ];
  for (const rule of result.rules) {
    lines.push("", rule.ruleId + "  " + rule.path + "  [" + rule.execution + "]");
    lines.push("  " + rule.reason);
    lines.push("  selector: " + rule.selector + "  |  candidates: " +
      (rule.selectorRan ? rule.candidateCount : "not evaluated (policy skipped)"));
    for (const d of rule.selectorDiagnostics)
      lines.push("  " + d.level.toUpperCase() + "  " + d.message);
  }
  if (verbose) {
    for (const item of result.inspections) {
      const focus = item.focusRange
        ? item.path + ":" + item.focusRange.start.line + ":" + item.focusRange.start.column +
          "-" + item.focusRange.end.line + ":" + item.focusRange.end.column
        : item.path + ":" + item.focusLineRange[0] + "-" + item.focusLineRange[1];
      lines.push("", item.ruleId + "  " + focus +
        (item.previewOnly ? "  [preview only: " + item.execution + "; NOT sent by check]" : "  [semantic]"));
      lines.push("  selector: " + item.selector);
      lines.push("  context: " + item.range[0] + "-" + item.range[1]);
      if (item.focusKind) lines.push("  focus kind: " + item.focusKind);
      lines.push("  semantic key: " + item.semanticKey);
      lines.push("  estimated request chars: " + item.estimatedRequestChars);
      lines.push(item.previewOnly ? "  hypothetical request (NOT sent by check):" : "  exact request (if judged):");
      lines.push(JSON.stringify({ state: item.request.state, question: item.request.question }, null, 2));
    }
  } else if (result.inspections.some((item) => item.previewOnly)) {
    lines.push("", "Hypothetical preview candidates are NOT sent by check.");
  }
  if (!result.rules.length) lines.push("", "No rules or source files selected.");
  lines.push("", "Use --verbose to see complete requests and semantic keys; --format json for complete structured data.");
  return lines.join("\n");
}
