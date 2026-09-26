import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { minimatch } from "minimatch";
import { noul } from "@mhingston5/jev-cli";
import {
  DEFAULT_SUPPRESSION_MARKER,
  findingFingerprint,
  inlineSuppressionReason,
  normalizedFindingText,
} from "./baseline.js";
import { FIXTURE_THIN_MARGIN } from "./calibration.js";
import { buildCandidates } from "./candidates.js";
import { discoverFiles } from "./files.js";
import { semanticDecisionKey } from "./replay.js";
import type {
  AnswerCache,
  CheckResult,
  Evaluation,
  Finding,
  FixtureRunResult,
  FixtureTestResult,
  JevCheckOptions,
  JevCheckRule,
  RunStats,
  SourceInput,
  SuppressedFinding,
} from "./types.js";

const DEFAULT_CHUNK_CHARS = 6000;
const DEFAULT_OVERLAP_LINES = 4;
const DEFAULT_CONTEXT_LINES = 20;
const DEFAULT_THRESHOLD = 0.8;
const CACHE_SEMANTICS_VERSION = "v4";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedRule(rule: JevCheckRule): Record<string, unknown> {
  return {
    id: rule.id,
    question: rule.question,
    severity: rule.severity ?? "error",
    status: rule.status ?? "shadow",
    files: rule.files ?? ["**/*"],
    exclude: rule.exclude ?? [],
    prefilter: rule.prefilter ?? null,
    unless: rule.unless ?? null,
    ast: rule.ast ?? null,
    wholeFile: rule.wholeFile ?? false,
    threshold: rule.threshold ?? DEFAULT_THRESHOLD,
    contextLines: rule.contextLines ?? null,
    criteria: rule.criteria ?? null,
  };
}

function ruleFingerprint(rule: JevCheckRule): string {
  return hash(JSON.stringify(normalizedRule(rule)));
}

export function ruleAppliesToFile(rule: JevCheckRule, path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const includes = rule.files ?? ["**/*"];
  if (!includes.some((pattern) => minimatch(normalized, pattern, { dot: true }))) return false;
  return !(rule.exclude ?? []).some((pattern) => minimatch(normalized, pattern, { dot: true }));
}

function emptyStats(): RunStats {
  return {
    filesChecked: 0,
    candidatesChecked: 0,
    requests: 0,
    cacheHits: 0,
    replayHits: 0,
    replayMisses: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function emptyResult(): CheckResult {
  return {
    findings: [],
    suppressedFindings: [],
    evaluations: [],
    diagnostics: [],
    stats: emptyStats(),
  };
}

function mergeStats(target: RunStats, source: RunStats): void {
  target.filesChecked += source.filesChecked;
  target.candidatesChecked += source.candidatesChecked;
  target.requests += source.requests;
  target.cacheHits += source.cacheHits;
  target.replayHits += source.replayHits;
  target.replayMisses += source.replayMisses;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
}

function mergeResult(target: CheckResult, source: CheckResult): void {
  target.findings.push(...source.findings);
  target.suppressedFindings.push(...source.suppressedFindings);
  target.evaluations.push(...source.evaluations);
  target.diagnostics.push(...source.diagnostics);
  mergeStats(target.stats, source.stats);
}

function cacheKey(
  namespace: string,
  ruleHash: string,
  path: string,
  contextStartLine: number,
  contextEndLine: number,
  focusStartLine: number,
  focusEndLine: number,
  focusStartColumn: number | undefined,
  focusEndColumn: number | undefined,
  focusKind: string | undefined,
  codeHash: string,
): string {
  return hash(
    [
      CACHE_SEMANTICS_VERSION,
      namespace,
      ruleHash,
      path,
      String(contextStartLine),
      String(contextEndLine),
      String(focusStartLine),
      String(focusEndLine),
      String(focusStartColumn ?? ""),
      String(focusEndColumn ?? ""),
      focusKind ?? "",
      codeHash,
    ].join("\n"),
  );
}

function labelsFor(rule: JevCheckRule): { true: string; false: string } {
  return {
    true: rule.criteria?.true ?? "The rule violation is present in the supplied code.",
    false: rule.criteria?.false ?? "The rule violation is not present in the supplied code.",
  };
}

function focusedQuestion(rule: JevCheckRule): string {
  return [
    "Judge only whether the rule is violated by code inside focusLineRange/focusRange.",
    "Code outside that focus is surrounding context only and must not itself cause a positive answer.",
    rule.question,
  ].join(" ");
}

function baselineKey(ruleId: string, path: string, fingerprint: string): string {
  return [ruleId, path.replaceAll("\\", "/"), fingerprint].join("\0");
}

export interface JevCheck {
  checkSource(path: string, source: string, onlyRuleIds?: string[]): Promise<CheckResult>;
  checkSources(sources: SourceInput[]): Promise<CheckResult>;
  checkFiles(paths: string[]): Promise<CheckResult>;
  testFixtures(cwd?: string): Promise<FixtureRunResult>;
}

export function createJevCheck(options: JevCheckOptions): JevCheck {
  const chunkChars = options.chunkChars ?? DEFAULT_CHUNK_CHARS;
  const overlapLines = options.overlapLines ?? DEFAULT_OVERLAP_LINES;
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
  const namespace = options.cacheNamespace ?? "default";
  const cache: AnswerCache | undefined = options.cache;
  if (options.replayOnly && !options.decisionStore) {
    throw new Error("replayOnly requires a semantic decision store");
  }
  if (!options.replayOnly && !options.client) {
    throw new Error("a Jev client is required unless replayOnly is enabled");
  }
  const suppressionMarker = options.suppressionMarker ?? DEFAULT_SUPPRESSION_MARKER;
  const baseline = new Set(
    (options.baseline ?? []).map((entry) => baselineKey(entry.ruleId, entry.path, entry.fingerprint)),
  );

  async function checkSourceInternal(
    path: string,
    source: string,
    onlyRuleIds?: string[],
    ignoreFileScope = false,
    applySuppressions = true,
  ): Promise<CheckResult> {
    const result = emptyResult();
    result.stats.filesChecked = 1;

    const selected = onlyRuleIds ? new Set(onlyRuleIds) : undefined;
    for (const rule of options.rules) {
      if (selected && !selected.has(rule.id)) continue;
      if (!ignoreFileScope && !ruleAppliesToFile(rule, path)) continue;

      const built = buildCandidates(path, source, rule, {
        chunkChars,
        overlapLines,
        contextLines,
      });
      result.diagnostics.push(...built.diagnostics);

      const rHash = ruleFingerprint(rule);
      const threshold = rule.threshold ?? DEFAULT_THRESHOLD;
      const severity = rule.severity ?? "error";
      const status = rule.status ?? "shadow";
      const occurrenceCounts = new Map<string, number>();

      for (const candidate of built.candidates) {
        result.stats.candidatesChecked += 1;
        const codeHash = hash(candidate.text);
        const key = cacheKey(
          namespace,
          rHash,
          path,
          candidate.startLine,
          candidate.endLine,
          candidate.focusStartLine,
          candidate.focusEndLine,
          candidate.focusStartColumn,
          candidate.focusEndColumn,
          candidate.focusKind,
          codeHash,
        );

        const identityText = normalizedFindingText(
          source,
          candidate.focusStartLine,
          candidate.focusEndLine,
        );
        const occurrence = occurrenceCounts.get(identityText) ?? 0;
        occurrenceCounts.set(identityText, occurrence + 1);

        const focusRange =
          candidate.focusStartColumn !== undefined && candidate.focusEndColumn !== undefined
            ? {
                start: {
                  line: candidate.focusStartLine,
                  column: candidate.focusStartColumn,
                },
                end: {
                  line: candidate.focusEndLine,
                  column: candidate.focusEndColumn,
                },
              }
            : undefined;
        const state = {
          path,
          lineRange: [candidate.startLine, candidate.endLine],
          focusLineRange: [candidate.focusStartLine, candidate.focusEndLine],
          ...(focusRange ? { focusRange } : {}),
          ...(candidate.focusKind ? { focusKind: candidate.focusKind } : {}),
          code: candidate.text,
        };
        const question = noul(focusedQuestion(rule), labelsFor(rule));
        const replayIdentity = semanticDecisionKey(question, state);

        let probability: number;
        let model: string;
        let cached = false;
        let replayed = false;

        if (options.replayOnly) {
          const recorded = await options.decisionStore!.get(replayIdentity.key);
          if (!recorded) {
            result.stats.replayMisses += 1;
            result.diagnostics.push({
              level: "error",
              path,
              ruleId: rule.id,
              message:
                "Replay miss for semantic request " +
                replayIdentity.key.slice(0, 12) +
                "; run jevcheck record with the same code and semantic rule inputs.",
            });
            continue;
          }
          probability = recorded.probability;
          model = recorded.model;
          replayed = true;
          result.stats.replayHits += 1;
        } else {
          const cachedDecision = cache ? await cache.get(key) : undefined;
          if (cachedDecision) {
            probability = cachedDecision.probability;
            model = cachedDecision.model;
            cached = true;
            result.stats.cacheHits += 1;
          } else {
            const response = await options.client!.systemOne({
              state,
              questions: { violation: question },
            });
            const answer = response.answers.violation;
            if (!answer || answer.type !== "noul") {
              throw new Error("Rule " + rule.id + " expected a Noul answer");
            }

            probability = answer.noul;
            model = response.model;
            result.stats.requests += 1;
            result.stats.inputTokens += response.usage?.input_tokens ?? 0;
            result.stats.outputTokens += response.usage?.output_tokens ?? 0;
            if (cache) await cache.set(key, { probability, model });
          }

          if (options.decisionStore) {
            await options.decisionStore.set({
              key: replayIdentity.key,
              semanticHash: replayIdentity.semanticHash,
              stateHash: replayIdentity.stateHash,
              ruleId: rule.id,
              path,
              startLine: candidate.focusStartLine,
              endLine: candidate.focusEndLine,
              startColumn: candidate.focusStartColumn,
              endColumn: candidate.focusEndColumn,
              focusKind: candidate.focusKind,
              probability,
              model,
            });
          }
        }

        const evaluation: Evaluation = {
          ruleId: rule.id,
          path,
          startLine: candidate.focusStartLine,
          endLine: candidate.focusEndLine,
          startColumn: candidate.focusStartColumn,
          endColumn: candidate.focusEndColumn,
          focusKind: candidate.focusKind,
          probability,
          threshold,
          model,
          cached,
          replayed,
          violates: probability >= threshold,
          ruleHash: rHash,
          codeHash,
        };
        result.evaluations.push(evaluation);

        if (evaluation.violates) {
          const fingerprint = findingFingerprint(
            rule.id,
            path,
            source,
            candidate.focusStartLine,
            candidate.focusEndLine,
            occurrence,
          );
          const finding: Finding = {
            ...evaluation,
            severity,
            status,
            blocking: status === "owned" && severity === "error",
            fingerprint,
            why: rule.why,
            source: rule.source,
          };

          if (applySuppressions) {
            const reason = inlineSuppressionReason(
              source,
              rule.id,
              finding.startLine,
              suppressionMarker,
            );
            if (reason) {
              const suppressed: SuppressedFinding = {
                ...finding,
                suppression: "inline",
                suppressionReason: reason,
              };
              result.suppressedFindings.push(suppressed);
              continue;
            }

            if (baseline.has(baselineKey(rule.id, path, fingerprint))) {
              result.suppressedFindings.push({ ...finding, suppression: "baseline" });
              continue;
            }
          }

          result.findings.push(finding);
        }
      }
    }

    return result;
  }

  async function checkSources(sources: SourceInput[]): Promise<CheckResult> {
    const result = emptyResult();
    for (const input of sources) {
      const normalizedPath = input.path.replaceAll("\\", "/");
      mergeResult(result, await checkSourceInternal(normalizedPath, input.source));
    }
    return result;
  }

  async function checkFiles(paths: string[]): Promise<CheckResult> {
    const sources: SourceInput[] = [];
    for (const path of paths) {
      sources.push({ path, source: await readFile(path, "utf8") });
    }
    return checkSources(sources);
  }

  async function testFixtures(cwd = process.cwd()): Promise<FixtureRunResult> {
    const tests: FixtureTestResult[] = [];
    const diagnostics: FixtureRunResult["diagnostics"] = [];
    const stats = emptyStats();

    for (const rule of options.rules) {
      const groups: Array<["valid" | "invalid", string[] | undefined]> = [
        ["valid", rule.fixtures?.valid],
        ["invalid", rule.fixtures?.invalid],
      ];

      for (const [expected, patterns] of groups) {
        if (!patterns?.length) continue;
        const paths = await discoverFiles(patterns, [], cwd);
        if (!paths.length) {
          diagnostics.push({
            level: "error",
            ruleId: rule.id,
            message: "Fixture patterns for " + expected + " matched no files: " + patterns.join(", "),
          });
          continue;
        }

        for (const path of paths) {
          const source = await readFile(resolve(cwd, path), "utf8");
          const fixtureResult = await checkSourceInternal(
            path.replaceAll("\\", "/"),
            source,
            [rule.id],
            true,
            false,
          );
          mergeStats(stats, fixtureResult.stats);
          diagnostics.push(...fixtureResult.diagnostics);
          const strongest = fixtureResult.evaluations.reduce<Evaluation | undefined>(
            (best, item) => (!best || item.probability > best.probability ? item : best),
            undefined,
          );
          const maxProbability = strongest?.probability ?? 0;
          const threshold = rule.threshold ?? DEFAULT_THRESHOLD;
          const violated = fixtureResult.evaluations.some((item) => item.violates);
          const passed = expected === "invalid" ? violated : !violated;
          const margin =
            expected === "invalid"
              ? maxProbability - threshold
              : threshold - maxProbability;
          tests.push({
            ruleId: rule.id,
            path,
            expected,
            passed,
            maxProbability,
            threshold,
            margin,
            thinMargin: passed && margin < FIXTURE_THIN_MARGIN,
            model: strongest?.model,
          });
        }
      }
    }

    return { tests, diagnostics, stats };
  }

  async function checkSource(path: string, source: string, onlyRuleIds?: string[]): Promise<CheckResult> {
    return checkSourceInternal(path, source, onlyRuleIds);
  }

  return { checkSource, checkSources, checkFiles, testFixtures };
}
