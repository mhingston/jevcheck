import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { minimatch } from "minimatch";
import { noul } from "@mhingston5/jev-cli";
import { buildCandidates } from "./candidates.js";
import { discoverFiles } from "./files.js";
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
} from "./types.js";

const DEFAULT_CHUNK_CHARS = 6000;
const DEFAULT_OVERLAP_LINES = 4;
const DEFAULT_CONTEXT_LINES = 20;
const DEFAULT_THRESHOLD = 0.8;

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
    wholeFile: rule.wholeFile ?? false,
    threshold: rule.threshold ?? DEFAULT_THRESHOLD,
    contextLines: rule.contextLines ?? null,
    criteria: rule.criteria ?? null,
  };
}

function ruleFingerprint(rule: JevCheckRule): string {
  return hash(JSON.stringify(normalizedRule(rule)));
}

function appliesToFile(rule: JevCheckRule, path: string): boolean {
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
    inputTokens: 0,
    outputTokens: 0,
  };
}

function mergeStats(target: RunStats, source: RunStats): void {
  target.filesChecked += source.filesChecked;
  target.candidatesChecked += source.candidatesChecked;
  target.requests += source.requests;
  target.cacheHits += source.cacheHits;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
}

function cacheKey(
  namespace: string,
  ruleHash: string,
  path: string,
  startLine: number,
  endLine: number,
  codeHash: string,
): string {
  return hash(["v1", namespace, ruleHash, path, String(startLine), String(endLine), codeHash].join("\n"));
}

function labelsFor(rule: JevCheckRule): { true: string; false: string } {
  return {
    true: rule.criteria?.true ?? "The rule violation is present in the supplied code.",
    false: rule.criteria?.false ?? "The rule violation is not present in the supplied code.",
  };
}

export interface JevCheck {
  checkSource(path: string, source: string, onlyRuleIds?: string[]): Promise<CheckResult>;
  checkFiles(paths: string[]): Promise<CheckResult>;
  testFixtures(cwd?: string): Promise<FixtureRunResult>;
}

export function createJevCheck(options: JevCheckOptions): JevCheck {
  const chunkChars = options.chunkChars ?? DEFAULT_CHUNK_CHARS;
  const overlapLines = options.overlapLines ?? DEFAULT_OVERLAP_LINES;
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
  const namespace = options.cacheNamespace ?? "default";
  const cache: AnswerCache | undefined = options.cache;

  async function checkSourceInternal(
    path: string,
    source: string,
    onlyRuleIds?: string[],
    ignoreFileScope = false,
  ): Promise<CheckResult> {
    const result: CheckResult = {
      findings: [],
      evaluations: [],
      diagnostics: [],
      stats: emptyStats(),
    };
    result.stats.filesChecked = 1;

    const selected = onlyRuleIds ? new Set(onlyRuleIds) : undefined;
    for (const rule of options.rules) {
      if (selected && !selected.has(rule.id)) continue;
      if (!ignoreFileScope && !appliesToFile(rule, path)) continue;

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

      for (const candidate of built.candidates) {
        result.stats.candidatesChecked += 1;
        const codeHash = hash(candidate.text);
        const key = cacheKey(namespace, rHash, path, candidate.startLine, candidate.endLine, codeHash);

        let probability: number;
        let model: string;
        let cached = false;
        const cachedDecision = cache ? await cache.get(key) : undefined;

        if (cachedDecision) {
          probability = cachedDecision.probability;
          model = cachedDecision.model;
          cached = true;
          result.stats.cacheHits += 1;
        } else {
          const response = await options.client.systemOne({
            state: {
              path,
              lineRange: [candidate.startLine, candidate.endLine],
              code: candidate.text,
            },
            questions: {
              violation: noul(rule.question, labelsFor(rule)),
            },
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

        const evaluation: Evaluation = {
          ruleId: rule.id,
          path,
          startLine: candidate.startLine,
          endLine: candidate.endLine,
          probability,
          threshold,
          model,
          cached,
          violates: probability >= threshold,
          ruleHash: rHash,
          codeHash,
        };
        result.evaluations.push(evaluation);

        if (evaluation.violates) {
          const finding: Finding = {
            ...evaluation,
            severity,
            status,
            blocking: status === "owned" && severity === "error",
            why: rule.why,
            source: rule.source,
          };
          result.findings.push(finding);
        }
      }
    }

    return result;
  }

  async function checkFiles(paths: string[]): Promise<CheckResult> {
    const result: CheckResult = {
      findings: [],
      evaluations: [],
      diagnostics: [],
      stats: emptyStats(),
    };

    for (const path of paths) {
      const source = await readFile(path, "utf8");
      const fileResult = await checkSourceInternal(path.replaceAll("\\", "/"), source);
      result.findings.push(...fileResult.findings);
      result.evaluations.push(...fileResult.evaluations);
      result.diagnostics.push(...fileResult.diagnostics);
      mergeStats(result.stats, fileResult.stats);
    }

    return result;
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
          const source = await readFile(path, "utf8");
          const fixtureResult = await checkSourceInternal(path.replaceAll("\\", "/"), source, [rule.id], true);
          mergeStats(stats, fixtureResult.stats);
          diagnostics.push(...fixtureResult.diagnostics);
          const probabilities = fixtureResult.evaluations.map((item) => item.probability);
          const maxProbability = probabilities.length ? Math.max(...probabilities) : 0;
          const violated = fixtureResult.evaluations.some((item) => item.violates);
          tests.push({
            ruleId: rule.id,
            path,
            expected,
            passed: expected === "invalid" ? violated : !violated,
            maxProbability,
            threshold: rule.threshold ?? DEFAULT_THRESHOLD,
          });
        }
      }
    }

    return { tests, diagnostics, stats };
  }

  async function checkSource(path: string, source: string, onlyRuleIds?: string[]): Promise<CheckResult> {
    return checkSourceInternal(path, source, onlyRuleIds);
  }

  return { checkSource, checkFiles, testFixtures };
}
