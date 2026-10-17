import { evidenceRemediation, evidenceState } from "./cli-output.js";
import type {
  CheckResult,
  FixtureDriftResult,
  FixtureRunResult,
  RecallRunResult,
  RobustnessRunResult,
  RuleEvidenceReport,
} from "./types.js";

export function formatStylish(result: CheckResult): string {
  const findings = [...result.findings].sort(
    (a, b) => a.path.localeCompare(b.path) || a.ruleId.localeCompare(b.ruleId) ||
      a.startLine - b.startLine || (a.startColumn ?? 0) - (b.startColumn ?? 0),
  );
  const blocking = findings.filter((f) => f.blocking).length;
  const errors = result.diagnostics.filter((d) => d.level === "error").length;
  const outcome = blocking || errors || result.stats.replayMisses ? "BLOCK" :
    findings.length || result.diagnostics.length ? "WARN" : "PASS";
  const lines = [outcome + "  Checked " + result.stats.filesChecked + " file(s)  |  " +
    findings.length + " findings (" + blocking + " blocking)  |  " +
    result.diagnostics.length + " diagnostics"];
  let previous = "";
  for (const finding of findings) {
    if (finding.path !== previous) { lines.push("", finding.path); previous = finding.path; }
    const range = finding.startColumn !== undefined && finding.endColumn !== undefined
      ? finding.startLine + ":" + finding.startColumn + "-" + finding.endLine + ":" + finding.endColumn
      : finding.startLine + "-" + finding.endLine;
    const kind = finding.blocking ? "error" : finding.status === "shadow" ? "shadow" : finding.severity;
    lines.push("  " + finding.path + ":" + range + "  " + kind.padEnd(7) +
      "  " + finding.ruleId + "  p=" + finding.probability.toFixed(2));
    if (finding.why) lines.push("    " + finding.why);
    if (finding.source) lines.push("    source: " + finding.source);
  }
  for (const d of result.diagnostics) {
    lines.push("", d.level + " " + [d.path, d.ruleId].filter(Boolean).join(" ") +
      ": " + d.message + " [" + (d.code ?? "EVALUATION_DIAGNOSTIC") + "]");
    if (d.code === "incomplete-evaluation")
      lines.push("  Next: fix the parser or rule scope; inspect with jevcheck inspect --verbose.");
  }
  if (!findings.length && !result.diagnostics.length) lines.push("", "No findings.");
  if (blocking) lines.push("", "Next: resolve owned/error findings and rerun jevcheck.");
  if (result.stats.replayMisses) lines.push("", "Next: record missing replay decisions and rerun replay.");
  lines.push("", result.suppressedFindings.length + " suppressed  |  " +
    result.stats.candidatesChecked + " candidates  |  " + result.stats.requests +
    " requests  |  " + result.stats.cacheHits + " cache hits  |  " +
    result.stats.replayHits + " replay hits  |  " + result.stats.replayMisses + " replay misses");
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
          ...(diagnostic.code ? { properties: { code: diagnostic.code } } : {}),
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
          : item.reason === "model"
            ? "model changed " +
              (item.beforeModel ?? "unknown") +
              " -> " +
              (item.afterModel ?? "unknown")
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


export function formatRobustnessStylish(result: RobustnessRunResult): string {
  const lines: string[] = [];

  for (const item of result.cases) {
    lines.push(
      (item.flipped ? "FLIP" : "PASS") +
        "  " +
        item.ruleId +
        "  " +
        item.expected +
        "  " +
        item.path +
        "  " +
        item.perturbation +
        "  " +
        item.baselineProbability.toFixed(3) +
        " -> " +
        item.perturbedProbability.toFixed(3) +
        "  |Δp|=" +
        item.delta.toFixed(3),
    );
  }

  for (const diagnostic of result.diagnostics) {
    lines.push(
      diagnostic.level.toUpperCase() +
        "  " +
        (diagnostic.ruleId ? diagnostic.ruleId + "  " : "") +
        (diagnostic.path ? diagnostic.path + "  " : "") +
        diagnostic.message,
    );
  }

  if (!result.cases.length) lines.push("No robustness cases measured.");
  lines.push(
    result.cases.length +
      "/" +
      result.expectedCases +
      " robustness case(s) measured, " +
      result.flips +
      " classification flip(s), max |Δp|=" +
      result.maxDelta.toFixed(3) +
      "; " +
      (result.complete ? "complete" : "INCOMPLETE") +
      "; " +
      result.stats.requests +
      " request(s)",
  );
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


export function formatRuleEvidenceStylish(reports: readonly RuleEvidenceReport[], verbose = false): string {
  if (!reports.length) return "No rules configured.";
  const active = reports.filter((r) => r.execution !== "inapplicable");
  const blocked = active.filter((r) => r.blockers.length > 0);
  const warnings = active.filter((r) => r.warnings.length > 0);
  const verified = reports.filter((r) => evidenceState(r) === "ci-verified").length;
  const reviewed = reports.filter((r) => evidenceState(r) === "reviewed-only").length;
  const inapplicable = reports.length - active.length;
  const lines = [
    (blocked.length ? "BLOCK" : warnings.length ? "WARN" : "PASS") + "  Rules audit: " +
      reports.length + " rule(s)  |  " + blocked.length + " blocked  |  " +
      warnings.length + " warnings  |  " + active.filter((r) => r.readyForOwned).length + " ready",
    "Coverage: " + verified + " CI-verified  |  " + reviewed +
      " reviewed-only (NOT a CI pass)  |  " + inapplicable + " inapplicable (NOT evidence-ready)",
  ];
  for (const report of reports) {
    const state = evidenceState(report);
    lines.push("", report.ruleId + "  " + report.currentStatus +
      "  [" + state + "]  execution=" + (report.execution ?? "semantic"));
    lines.push("  Ready for owned: " +
      (state === "inapplicable" ? "n/a (inapplicable)" : report.readyForOwned ? "yes" : "no"));
    if (verbose) {
      for (const check of report.checks)
        lines.push("  " + check.id + "  " + check.status.toUpperCase() + "  " + check.message);
    } else if (state === "reviewed-only")
      lines.push("  Current human review only; passing CI execution NOT verified.");
    else if (state === "ci-verified")
      lines.push("  Current reviewed coverage and passing CI checks.");
    const failed = report.checks.filter((c) => c.status !== "pass");
    for (const check of failed) {
      lines.push("  " + (check.status === "block" ? "BLOCKER: " : "WARNING: ") +
        check.message + " [" + check.id + "]");
      const advice = evidenceRemediation(check);
      if (advice.suggestedCommand) lines.push("  Next: " + advice.suggestedCommand);
      else if (advice.remediation) lines.push("  Next: " + advice.remediation);
    }
    if (!failed.length && report.blockers.length)
      lines.push(...report.blockers.map((message) => "  BLOCKER: " + message));
  }
  lines.push("", "Use --verbose for all checks; --format json for full evidence.");
  return lines.join("\n");
}
