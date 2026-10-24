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
  /** Set only for the complete configured source discovery, never for diffs or subsets. */
  fullScope?: boolean;
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

export type RuleScopeState = "no-files-in-scope" | "project-inapplicable" | "applicable" | "covered";

export interface RuleScopeHealth {
  ruleId: string;
  state: RuleScopeState;
  /** Sources admitted by top-level discovery AND the per-rule files/exclude policy. */
  filesInScope: number;
  reason: string;
}

/** A provider-free bound on eligible semantic work, not an estimate of billed calls or tokens. */
export interface InspectPreflight {
  /** Selected source inputs, including files with no matching rules. */
  files: number;
  /** Every evaluated rule/file runtime policy, including policy-skipped pairs. */
  policyPairs: Record<RuleExecution, number>;
  /** Maximum uncached judge calls before cache/deduplication and runtime failures. */
  eligibleCandidates: number;
  /** Sum of serialized {state, question} lengths for eligible requests; NOT tokens. */
  estimatedRequestChars: number;
  /** Hypothetical skipped-rule candidates, never counted as eligible calls or bytes. */
  previewOnlyCandidates: number;
  /** Completed semantic selectors with no candidates and no diagnostics. */
  cleanZeroCandidateSemanticPairs: number;
  /** Semantic selectors reporting warnings/errors; zero candidates may be incomplete. */
  semanticPairsWithDiagnostics: number;
  /** Selector diagnostics from eligible rule/file pairs only. */
  eligibleSelectorDiagnostics: { errors: number; warnings: number };
  /** Selector diagnostics from skipped rule/file pairs, if previewed. */
  previewSelectorDiagnostics: { errors: number; warnings: number };
}

export interface InspectResult {
  rules: RuleInspection[];
  inspections: SemanticInspection[];
  /** Eligible selector diagnostics and full-scope advisory scope warnings. */
  diagnostics: Diagnostic[];
  /** Empty in diff/path-limited inspections; absence does not establish rule health. */
  scopeHealth: RuleScopeHealth[];
  preflight: InspectPreflight;
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
  const result: InspectResult = {
    rules: [], inspections: [], diagnostics: [], scopeHealth: [],
    preflight: {
      files: inputs.length,
      policyPairs: { semantic: 0, covered: 0, inapplicable: 0 },
      eligibleCandidates: 0,
      estimatedRequestChars: 0,
      previewOnlyCandidates: 0,
      cleanZeroCandidateSemanticPairs: 0,
      semanticPairsWithDiagnostics: 0,
      eligibleSelectorDiagnostics: { errors: 0, warnings: 0 },
      previewSelectorDiagnostics: { errors: 0, warnings: 0 },
    },
  };
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

  // Iterate rules independently of candidate selection so a zero-file rule is observable.
  // Count file applicability from the SAME execution-policy resolver as enforcement.
  const scopeByRule = new Map<string, {
    filesInScope: number;
    policies: Record<RuleExecution, number>;
    reasons: Partial<Record<RuleExecution, string>>;
  }>(rules.map((rule) => [rule.id, {
    filesInScope: 0,
    policies: { semantic: 0, covered: 0, inapplicable: 0 } as Record<RuleExecution, number>,
    reasons: {} as Partial<Record<RuleExecution, string>>,
  }]));

  for (const input of inputs) {
    for (const rule of rules) {
      const policy = await resolveExecution(rule, input.path);
      if (policy.fileApplicable) {
        const scope = scopeByRule.get(rule.id)!;
        scope.filesInScope++;
        scope.policies[policy.execution]++;
        scope.reasons[policy.execution] ??= policy.reason;
      }
      const selector = selectorDescription(rule);
      const selectorRan = policy.execution === "semantic" || options.previewSkipped === true;
      const built = selectorRan
        ? buildCandidates(input.path, input.source, rule, candidateOptions)
        : { candidates: [], diagnostics: [] as Diagnostic[] };
      result.preflight.policyPairs[policy.execution]++;
      const selectorDiagnostics = policy.execution === "semantic"
        ? result.preflight.eligibleSelectorDiagnostics
        : result.preflight.previewSelectorDiagnostics;
      for (const diagnostic of built.diagnostics) selectorDiagnostics[
        diagnostic.level === "error" ? "errors" : "warnings"
      ]++;
      if (policy.execution === "semantic") {
        if (built.diagnostics.length) result.preflight.semanticPairsWithDiagnostics++;
        else if (built.candidates.length === 0) result.preflight.cleanZeroCandidateSemanticPairs++;
      }
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
        if (policy.execution === "semantic") {
          result.preflight.eligibleCandidates++;
          result.preflight.estimatedRequestChars += serialized.length;
        } else {
          result.preflight.previewOnlyCandidates++;
        }
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
  if (options.fullScope) {
    for (const rule of rules) {
      const scope = scopeByRule.get(rule.id)!;
      const state: RuleScopeState = scope.filesInScope === 0 ? "no-files-in-scope"
        : scope.policies.semantic > 0 ? "applicable"
        : scope.policies.covered > 0 ? "covered" : "project-inapplicable";
      const reason = state === "no-files-in-scope"
        ? "No discovered sources match rule " + rule.id +
          " after top-level include/exclude and rule files/exclude. Review file globs and repository layout."
        : state === "applicable"
          ? "At least one scoped file is eligible for semantic judgement; zero selector candidates is a valid result."
          : state === "covered"
            ? scope.reasons.covered ?? "Rule is suppressed by reviewed deterministic coverage."
            : scope.reasons.inapplicable ?? "Rule is excluded by project or architecture-decision policy.";
      result.scopeHealth.push({ ruleId: rule.id, state, filesInScope: scope.filesInScope, reason });
      if (state === "no-files-in-scope") {
        result.diagnostics.push({ code: "no-files-in-scope", level: "warning", ruleId: rule.id, message: reason });
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
  const { preflight } = result;
  const { semantic, covered, inapplicable } = preflight.policyPairs;
  const errors = result.diagnostics.filter((d) => d.level === "error").length;
  const lines = [
    (errors ? "BLOCK" : result.diagnostics.length ? "WARN" : "PASS") +
      "  Inspect: " + preflight.files + " selected files  |  " +
      result.rules.length + " rule/file policies  |  " +
      semantic + " semantic  |  " + covered + " covered  |  " + inapplicable + " inapplicable",
    "  Preflight: at most " + preflight.eligibleCandidates +
      " uncached judge calls (eligible candidates)  |  " +
      preflight.estimatedRequestChars + " request chars (not tokens/cost)  |  " +
      preflight.previewOnlyCandidates + " preview only (excluded)",
    "  Selectors: " + preflight.cleanZeroCandidateSemanticPairs + " clean zero-match semantic pairs  |  " +
      preflight.semanticPairsWithDiagnostics + " semantic pairs with diagnostics (" +
      preflight.eligibleSelectorDiagnostics.errors + " errors, " +
      preflight.eligibleSelectorDiagnostics.warnings + " warnings)" +
      (preflight.previewSelectorDiagnostics.errors + preflight.previewSelectorDiagnostics.warnings
        ? "  |  preview-only diagnostics: " + preflight.previewSelectorDiagnostics.errors +
          " errors, " + preflight.previewSelectorDiagnostics.warnings + " warnings (excluded)"
        : ""),
  ];
  if (result.scopeHealth.length) {
    const count = (state: RuleScopeState) => result.scopeHealth.filter((item) => item.state === state).length;
    lines.push("  Scope health: " + count("applicable") + " applicable  |  " +
      count("covered") + " covered  |  " + count("project-inapplicable") +
      " project-inapplicable  |  " + count("no-files-in-scope") + " no-files-in-scope");
    for (const scope of result.scopeHealth) {
      lines.push("    " + scope.ruleId + "  [" + scope.state + "]  " +
        scope.filesInScope + " scoped file(s): " + scope.reason);
    }
  }
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
  if (!result.rules.length) lines.push("", "No rule/file policies selected.");
  lines.push("", "Use --verbose to see complete requests and semantic keys; --format json for complete structured data.");
  return lines.join("\n");
}
