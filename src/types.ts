import type { SystemOneLikeClient } from "@mhingston5/jev-cli";

export type RuleSeverity = "error" | "warning";
export type RuleStatus = "shadow" | "owned";
export type AstLanguage = "typescript" | "tsx";

export interface RuleCriteria {
  true?: string;
  false?: string;
}

export interface RuleFixtures {
  valid?: string[];
  invalid?: string[];
}

export interface AstCandidateConfig {
  language: AstLanguage;
  rule: Record<string, unknown>;
  contextBefore?: number;
  contextAfter?: number;
}

export interface JevCheckRule {
  id: string;
  question: string;
  why?: string;
  source?: string;
  severity?: RuleSeverity;
  status?: RuleStatus;
  files?: string[];
  exclude?: string[];
  prefilter?: string;
  unless?: string;
  ast?: AstCandidateConfig;
  wholeFile?: boolean;
  threshold?: number;
  contextLines?: number;
  criteria?: RuleCriteria;
  fixtures?: RuleFixtures;
}

export interface JevCheckConfig {
  include?: string[];
  exclude?: string[];
  chunkChars?: number;
  overlapLines?: number;
  contextLines?: number;
  cacheFile?: string;
  baselineFile?: string;
  suppressionMarker?: string;
  rules: JevCheckRule[];
}

export interface Candidate {
  text: string;
  startLine: number;
  endLine: number;
  focusStartLine: number;
  focusEndLine: number;
}

export interface SourceInput {
  path: string;
  source: string;
}

export interface Evaluation {
  ruleId: string;
  path: string;
  startLine: number;
  endLine: number;
  probability: number;
  threshold: number;
  model: string;
  cached: boolean;
  violates: boolean;
  ruleHash: string;
  codeHash: string;
}

export interface Finding extends Evaluation {
  severity: RuleSeverity;
  status: RuleStatus;
  blocking: boolean;
  fingerprint: string;
  why?: string;
  source?: string;
}

export type SuppressionKind = "baseline" | "inline";

export interface SuppressedFinding extends Finding {
  suppression: SuppressionKind;
  suppressionReason?: string;
}

export interface BaselineEntry {
  ruleId: string;
  path: string;
  fingerprint: string;
}

export interface Diagnostic {
  level: "warning" | "error";
  message: string;
  path?: string;
  ruleId?: string;
}

export interface RunStats {
  filesChecked: number;
  candidatesChecked: number;
  requests: number;
  cacheHits: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CheckResult {
  findings: Finding[];
  suppressedFindings: SuppressedFinding[];
  evaluations: Evaluation[];
  diagnostics: Diagnostic[];
  stats: RunStats;
}

export interface CachedDecision {
  probability: number;
  model: string;
}

export interface AnswerCache {
  get(key: string): Promise<CachedDecision | undefined>;
  set(key: string, value: CachedDecision): Promise<void>;
}

export interface JevCheckOptions {
  client: SystemOneLikeClient;
  rules: JevCheckRule[];
  cache?: AnswerCache;
  cacheNamespace?: string;
  chunkChars?: number;
  overlapLines?: number;
  contextLines?: number;
  baseline?: BaselineEntry[];
  suppressionMarker?: string;
}

export interface FixtureTestResult {
  ruleId: string;
  path: string;
  expected: "valid" | "invalid";
  passed: boolean;
  maxProbability: number;
  threshold: number;
}

export interface FixtureRunResult {
  tests: FixtureTestResult[];
  diagnostics: Diagnostic[];
  stats: RunStats;
}
