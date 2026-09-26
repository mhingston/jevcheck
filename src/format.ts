import type { CheckResult, FixtureDriftResult, FixtureRunResult, RecallRunResult, RuleEvidenceReport } from "./types.js";

export function formatStylish(result: CheckResult): string {
  const lines: string[] = [];
  const findings = [...result.findings].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.startLine - b.startLine ||
      (a.startColumn ?? 0) - (b.startColumn ?? 0) ||
      a.ruleId.localeCompare(b.ruleId),
  );

  for (const finding of findings) {
    const kind = finding.blocking ? "error" : finding.status === "shadow" ? "shadow" : finding.severity;
    const range =
      finding.startColumn !== undefined && finding.endColumn !== undefined
        ? finding.startLine +
          ":" +
          finding.startColumn +
          "-" +
          finding.endLine +
          ":" +
          finding.endColumn
        : finding.startLine + "-" + finding.endLine;
    lines.push(
      finding.path +
        ":" +
        range +
        "  " +
        kind.padEnd(7) +
        "  " +
        finding.ruleId +
        "  p=" +
        finding.probability.toFixed(2) +
        " >= " +
        finding.threshold.toFixed(2),
    );
    if (finding.why) lines.push("  " + finding.why);
    if (finding.source) lines.push("  source: " + finding.source);
  }

  for (const diagnostic of result.diagnostics) {
    const location = [diagnostic.path, diagnostic.ruleId].filter(Boolean).join(" ");
    lines.push(
      (diagnostic.level === "error" ? "error" : "warning") +
        (location ? " " + location : "") +
        ": " +
        diagnostic.message,
    );
  }

  if (!findings.length && !result.diagnostics.length) lines.push("No findings.");

  const blocking = findings.filter((finding) => finding.blocking).length;
  lines.push(
    result.findings.length +
      " finding(s), " +
      blocking +
      " blocking, " +
      result.suppressedFindings.length +
      " suppressed; " +
      result.stats.filesChecked +
      " file(s), " +
      result.stats.candidatesChecked +
      " candidate(s), " +
      result.stats.requests +
      " request(s), " +
      result.stats.cacheHits +
      " cache hit(s), " +
      result.stats.replayHits +
      " replay hit(s), " +
      result.stats.replayMisses +
      " replay miss(es)",
  );

  return lines.join("\n");
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function sarifLevel(status: "shadow" | "owned", severity: "error" | "warning"): "error" | "warning" | "note" {
  if (status === "shadow") return "note";
  return severity === "error" ? "error" : "warning";
}

function sarifUri(path: string): string {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export function formatSarif(result: CheckResult): string {
  const rules = new Map<string, { id: string; why?: string; source?: string }>();
  for (const finding of result.findings) {
    if (!rules.has(finding.ruleId)) {
      rules.set(finding.ruleId, { id: finding.ruleId, why: finding.why, source: finding.source });
    }
  }

  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: "jevcheck",
          informationUri: "https://github.com/mhingston/jevcheck",
          rules: [...rules.values()].map((rule) => ({
            id: rule.id,
            shortDescription: { text: rule.why ?? rule.id },
            ...(rule.source ? { help: { text: "Source: " + rule.source } } : {}),
          })),
        },
      },
      results: result.findings.map((finding) => ({
        ruleId: finding.ruleId,
        level: sarifLevel(finding.status, finding.severity),
        message: {
          text:
            (finding.why ?? "Semantic rule violation") +
            " (p=" +
            finding.probability.toFixed(2) +
            ", threshold=" +
            finding.threshold.toFixed(2) +
            ")",
        },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: sarifUri(finding.path) },
            region: {
              startLine: finding.startLine,
              endLine: finding.endLine,
              ...(finding.startColumn !== undefined ? { startColumn: finding.startColumn } : {}),
              ...(finding.endColumn !== undefined ? { endColumn: finding.endColumn } : {}),
            },
          },
        }],
        partialFingerprints: {
          "jevcheck/v1": finding.fingerprint,
        },
        properties: {
          probability: finding.probability,
          threshold: finding.threshold,
          status: finding.status,
          model: finding.model,
          blocking: finding.blocking,
          ...(finding.focusKind ? { focusKind: finding.focusKind } : {}),
        },
      })),
      invocations: [{
        executionSuccessful: !result.diagnostics.some((item) => item.level === "error"),
        toolExecutionNotifications: result.diagnostics.map((diagnostic) => ({
          level: diagnostic.level === "error" ? "error" : "warning",
          message: {
            text:
              [diagnostic.path, diagnostic.ruleId].filter(Boolean).join(" ") +
              (diagnostic.path || diagnostic.ruleId ? ": " : "") +
              diagnostic.message,
          },
        })),
      }],
    }],
  };

  return JSON.stringify(sarif, null, 2);
}

export function formatFixtureStylish(result: FixtureRunResult): string {
  const lines = result.tests.map((test) => {
    return (
      (test.passed ? "PASS" : "FAIL") +
      "  " +
      test.ruleId +
      "  " +
      test.expected +
      "  " +
      test.path +
      "  max p=" +
      test.maxProbability.toFixed(2) +
      " threshold=" +
      test.threshold.toFixed(2) +
      " margin=" +
      test.margin.toFixed(2) +
      (test.thinMargin ? " THIN" : "")
    );
  });

  for (const diagnostic of result.diagnostics) {
    lines.push(
      diagnostic.level.toUpperCase() +
        "  " +
        (diagnostic.ruleId ? diagnostic.ruleId + "  " : "") +
        diagnostic.message,
    );
  }

  const failures = result.tests.filter((test) => !test.passed).length;
  const thin = result.tests.filter((test) => test.thinMargin).length;
  lines.push(
    result.tests.length +
      " fixture(s), " +
      failures +
      " failure(s), " +
      thin +
      " thin margin(s)",
  );
  return lines.join("\n");
}

export function formatFixtureDriftStylish(result: FixtureDriftResult): string {
  const lines = [
    "Drift: mean |Δp| " +
      result.meanAbsoluteDelta.toFixed(3) +
      " across " +
      result.compared +
      " fixture(s); " +
      result.moved.length +
      " moved >= " +
      result.driftThreshold.toFixed(2) +
      "; " +
      result.stale.length +
      " stale; " +
      result.added.length +
      " added; " +
      result.removed.length +
      " removed",
  ];

  for (const item of result.moved) {
    lines.push(
      "  " +
        item.ruleId +
        "  " +
        item.expected +
        "  " +
        item.path +
        "  " +
        item.before.toFixed(3) +
        " -> " +
        item.after.toFixed(3) +
        "  |Δp|=" +
        item.delta.toFixed(3) +
        (item.beforeModel || item.afterModel
          ? "  model=" + (item.beforeModel ?? "?") + " -> " + (item.afterModel ?? "?")
          : ""),
    );
  }

  for (const item of result.stale) {
    lines.push(
      "  STALE  " +
        item.ruleId +
        "  " +
        item.expected +
        "  " +
        item.path +
        "  " +
        (item.reason === "threshold"
          ? "threshold changed " +
            item.beforeThreshold.toFixed(2) +
            " -> " +
            item.afterThreshold.toFixed(2)
          : "semantic inputs changed") +
        "; re-record calibration",
    );
  }

  for (const item of result.added) {
    lines.push("  ADDED  " + item.ruleId + "  " + item.expected + "  " + item.path);
  }
  for (const item of result.removed) {
    lines.push("  REMOVED  " + item.ruleId + "  " + item.expected + "  " + item.path);
  }

  return lines.join("\n");
}


export function formatRecallStylish(result: RecallRunResult): string {
  const lines: string[] = [];

  for (const item of result.mutants) {
    lines.push(
      item.ruleId +
        "  " +
        item.mutantId +
        "  " +
        item.caught +
        "/" +
        item.judged +
        " caught" +
        (item.recall !== undefined ? "  recall=" + item.recall.toFixed(2) : "  recall=n/a") +
        "  sampled=" +
        item.sampled +
        "/" +
        item.candidateCount,
    );
    for (const path of item.misses) lines.push("  MISS     " + path);
    for (const path of item.invalidOriginals) lines.push("  INVALID  " + path + "  original already violates");
  }

  for (const diagnostic of result.diagnostics) {
    lines.push(
      diagnostic.level.toUpperCase() +
        "  " +
        (diagnostic.ruleId ? diagnostic.ruleId + "  " : "") +
        diagnostic.message,
    );
  }

  if (!result.mutants.length) lines.push("No configured mutants.");
  lines.push(
    "Weakest measured recall: " +
      (result.weakestRecall !== undefined ? result.weakestRecall.toFixed(2) : "n/a") +
      "; " +
      result.stats.requests +
      " request(s), " +
      result.stats.cacheHits +
      " cache hit(s)",
  );
  return lines.join("\n");
}


export function formatRuleEvidenceStylish(reports: readonly RuleEvidenceReport[]): string {
  if (!reports.length) return "No rules configured.";

  return reports.map((report) => {
    const lines = [report.ruleId + "  " + report.currentStatus, ""];
    for (const check of report.checks) {
      lines.push(
        check.id.replaceAll("-", " ").padEnd(14) +
          check.status.toUpperCase().padEnd(7) +
          check.message,
      );
    }
    if (report.blockers.length) {
      lines.push("", ...report.blockers.map((message) => "BLOCKER: " + message));
    }
    if (report.warnings.length) {
      lines.push(...report.warnings.map((message) => "WARNING: " + message));
    }
    lines.push("", "Ready for owned: " + (report.readyForOwned ? "yes" : "no"));
    return lines.join("\n");
  }).join("\n\n");
}
