import type { SystemOneLikeClient } from "@mhingston5/jev-cli";

export type RuleSeverity = "error" | "warning";
export type RuleStatus = "shadow" | "owned";
export type AstLanguage = "javascript" | "typescript" | "tsx" | "html" | "css";

export type AstSelector =
  | { pattern: string; kind?: never; rule?: never }
  | { kind: string; pattern?: never; rule?: never }
  | { rule: Record<string, unknown>; pattern?: never; kind?: never };

export interface AstContextConfig {
  ancestor?: AstSelector;
}

export type AstCandidateConfig = AstSelector & {
  language?: AstLanguage;
  contextBefore?: number;
  contextAfter?: number;
  context?: AstContextConfig;
};

export interface RuleCriteria {
  true?: string;
  false?: string;
}

export interface RuleFixtures {
  valid?: string[];
  invalid?: string[];
}

export interface RuleMutant {
  id: string;
  pattern: string;
  replacement: string;
  replaceAll?: boolean;
}

export interface RuleEvidencePolicy {
  requireValidFixture: boolean;
  requireInvalidFixture: boolean;
  allowThinMargins: boolean;
  requireCurrentCalibration: boolean;
  requireCleanDrift: boolean;
  requireMutants: boolean;
  minMutationRecall: number;
  requireSource: boolean;
}

export type RuleEvidenceCheckStatus = "pass" | "warn" | "block";

export interface RuleEvidenceCheck {
  id: string;
  status: RuleEvidenceCheckStatus;
  message: string;
}

export interface RuleEvidenceReport {
  ruleId: string;
  currentStatus: RuleStatus;
  checks: RuleEvidenceCheck[];
  blockers: string[];
  warnings: string[];
  readyForOwned: boolean;
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
  mutants?: RuleMutant[];
}

export interface JevCheckConfig {
  include?: string[];
  exclude?: string[];
  chunkChars?: number;
  overlapLines?: number;
  contextLines?: number;
  cacheFile?: string;
  baselineFile?: string;
  replayFile?: string;
  calibrationFile?: string;
  evidenceFile?: string;
  driftThreshold?: number;
  graduation?: Partial<RuleEvidencePolicy>;
  suppressionMarker?: string;
  rules: JevCheckRule[];
}

export interface Candidate {
  text: string;
  startLine: number;
  endLine: number;
  focusStartLine: number;
  focusEndLine: number;
  focusStartColumn?: number;
  focusEndColumn?: number;
  focusKind?: string;
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
  startColumn?: number;
  endColumn?: number;
  focusKind?: string;
  probability: number;
  threshold: number;
  model: string;
  cached: boolean;
  replayed?: boolean;
  semanticKey: string;
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
  replayHits: number;
  replayMisses: number;
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

export interface RecordedSemanticDecision {
  key: string;
  semanticHash: string;
  stateHash: string;
  ruleId: string;
  path: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
  focusKind?: string;
  probability: number;
  model: string;
}

export interface SemanticDecisionStore {
  get(key: string): Promise<RecordedSemanticDecision | undefined>;
  set(value: RecordedSemanticDecision): Promise<void>;
  count?(): Promise<number>;
  flush?(): Promise<void>;
}

export interface JevCheckOptions {
  client?: SystemOneLikeClient;
  rules: JevCheckRule[];
  cache?: AnswerCache;
  cacheNamespace?: string;
  chunkChars?: number;
  overlapLines?: number;
  contextLines?: number;
  baseline?: BaselineEntry[];
  suppressionMarker?: string;
  decisionStore?: SemanticDecisionStore;
  replayOnly?: boolean;
  mode?: "enforce" | "measure";
  ruleEvidenceReports?: readonly RuleEvidenceReport[];
}

export interface FixtureTestResult {
  ruleId: string;
  path: string;
  expected: "valid" | "invalid";
  passed: boolean;
  maxProbability: number;
  threshold: number;
  margin: number;
  thinMargin: boolean;
  semanticKeys: string[];
  model?: string;
}

export interface FixtureCalibrationEntry {
  ruleId: string;
  path: string;
  expected: "valid" | "invalid";
  probability: number;
  threshold: number;
  semanticKeys: string[];
  model?: string;
}

export interface FixtureDriftItem {
  ruleId: string;
  path: string;
  expected: "valid" | "invalid";
  before: number;
  after: number;
  delta: number;
  beforeThreshold: number;
  afterThreshold: number;
  beforeModel?: string;
  afterModel?: string;
}

export interface FixtureDriftStale {
  ruleId: string;
  path: string;
  expected: "valid" | "invalid";
  reason: "semantic-inputs" | "threshold";
  beforeSemanticKeys: string[];
  afterSemanticKeys: string[];
  beforeThreshold: number;
  afterThreshold: number;
}

export interface FixtureDriftResult {
  compared: number;
  meanAbsoluteDelta: number;
  moved: FixtureDriftItem[];
  stale: FixtureDriftStale[];
  added: FixtureCalibrationEntry[];
  removed: FixtureCalibrationEntry[];
  driftThreshold: number;
}

export interface FixtureRunResult {
  tests: FixtureTestResult[];
  diagnostics: Diagnostic[];
  stats: RunStats;
}

export type RobustnessPerturbationId =
  | "direct-instruction"
  | "false-authority"
  | "irrelevant-context";

export interface RobustnessCaseResult {
  ruleId: string;
  path: string;
  expected: "valid" | "invalid";
  perturbation: RobustnessPerturbationId;
  baselineProbability: number;
  perturbedProbability: number;
  delta: number;
  threshold: number;
  baselineViolated: boolean;
  perturbedViolated: boolean;
  flipped: boolean;
  model?: string;
}

export interface RobustnessRunResult {
  cases: RobustnessCaseResult[];
  diagnostics: Diagnostic[];
  stats: RunStats;
  flips: number;
  maxDelta: number;
  expectedCases: number;
  complete: boolean;
}

export interface RuleThresholdDiagnostic {
  ruleId: string;
  validMax?: number;
  invalidMin?: number;
  separation?: number;
  currentThreshold?: number;
  separable: boolean;
}

export interface RecallMutantResult {
  ruleId: string;
  mutantId: string;
  candidateCount: number;
  sampled: number;
  judged: number;
  caught: number;
  recall?: number;
  misses: string[];
  invalidOriginals: string[];
}

export interface RecallRunResult {
  mutants: RecallMutantResult[];
  weakestRecall?: number;
  diagnostics: Diagnostic[];
  stats: RunStats;
}
