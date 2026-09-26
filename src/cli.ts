#!/usr/bin/env node
import { resolve } from "node:path";
import { createJevClient, JEV_PROVIDERS, type JevProvider } from "@mhingston5/jev-cli";
import {
  DEFAULT_BASELINE_FILE,
  baselineEntry,
  baselineScopeKey,
  readBaseline,
  writeBaseline,
} from "./baseline.js";
import { DiskAnswerCache } from "./cache.js";
import {
  DEFAULT_CALIBRATION_FILE,
  compareCalibration,
  readCalibration,
  writeCalibration,
} from "./calibration.js";
import { loadConfig } from "./config.js";
import { createJevCheck, ruleAppliesToFile } from "./engine.js";
import { collectCurrentFixtureEvidence } from "./evidence.js";
import {
  DEFAULT_EVIDENCE_FILE,
  DEFAULT_SOURCE_INCLUDE,
  evaluateConfiguredRuleEvidence,
  persistDriftEvidence,
  persistMutationEvidence,
} from "./evidence-store.js";
import { discoverFiles, filterFiles } from "./files.js";
import {
  formatFixtureDriftStylish,
  formatFixtureStylish,
  formatJson,
  formatRecallStylish,
  formatRuleEvidenceStylish,
  formatSarif,
  formatStylish,
} from "./format.js";
import { changedFiles, stagedSources } from "./git.js";
import { DEFAULT_REPLAY_FILE, DiskSemanticDecisionStore } from "./replay.js";
import type { SourceInput } from "./types.js";

type Command = "check" | "test" | "list" | "baseline" | "record" | "replay" | "recall" | "rules-audit";
type OutputFormat = "stylish" | "json" | "sarif";

interface CliOptions {
  command: Command;
  config: string;
  format: OutputFormat;
  changed: boolean;
  staged: boolean;
  base?: string;
  provider?: JevProvider;
  model?: string;
  cache: boolean;
  testRecord: boolean;
  testDrift: boolean;
  sampleSize: number;
  sampleSizeSet: boolean;
  patterns: string[];
}

function usage(): string {
  return [
    "jevcheck - bounded semantic linting with Jev",
    "",
    "Usage:",
    "  jevcheck [patterns...] [options]",
    "  jevcheck test [options]",
    "  jevcheck list [options]",
    "  jevcheck baseline [patterns...] [options]",
    "  jevcheck record [patterns...] [options]",
    "  jevcheck replay [patterns...] [options]",
    "  jevcheck recall [patterns...] [options]",
    "  jevcheck rules audit [options]",
    "",
    "Options:",
    "  --config <path>       Config file (default: jevcheck.config.json)",
    "  --changed             Check working-tree changes and untracked files",
    "  --staged              Check the exact staged index snapshot",
    "  --base <ref>          With --changed, check base...HEAD",
    "  --format <style>      stylish, json, or sarif (sarif: check/replay only)",
    "  --provider <name>     Jev provider inherited from @mhingston5/jev-cli",
    "  --model <name>        Override the provider model",
    "  --no-cache            Disable the answer cache",
    "  --record              With test, record fixture probabilities",
    "  --drift               With test, re-ask fixtures and compare calibration",
    "  --sample-size <n>     With recall, files sampled per mutant (default: 12)",
    "  -h, --help            Show help",
    "",
    "record captures semantic decisions to replayFile (default: .jevcheck/replay.json).",
    "replay is strict and offline: missing decisions are errors and never reach a provider.",
    "test --record writes calibrationFile; test --drift bypasses the answer cache.",
    "recall mutates sampled real files in memory; repository files are never modified.",
    "",
    "Only owned error findings make the check command exit 1. Shadow findings are advisory.",
  ].join("\n");
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(flag + " requires a value");
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  let command: Command = "check";
  if (args[0] === "rules" && args[1] === "audit") {
    command = "rules-audit";
    args.splice(0, 2);
  } else if (
    args[0] === "test" ||
    args[0] === "list" ||
    args[0] === "baseline" ||
    args[0] === "record" ||
    args[0] === "replay" ||
    args[0] === "recall"
  ) {
    command = args.shift() as Command;
  }

  const options: CliOptions = {
    command,
    config: "jevcheck.config.json",
    format: "stylish",
    changed: false,
    staged: false,
    cache: true,
    testRecord: false,
    testDrift: false,
    sampleSize: 12,
    sampleSizeSet: false,
    patterns: [],
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case "--config":
        options.config = requireValue(args, i, arg);
        i += 1;
        break;
      case "--format": {
        const value = requireValue(args, i, arg);
        if (value !== "stylish" && value !== "json" && value !== "sarif") {
          throw new Error("--format must be stylish, json, or sarif");
        }
        options.format = value;
        i += 1;
        break;
      }
      case "--changed":
        options.changed = true;
        break;
      case "--staged":
        options.staged = true;
        break;
      case "--base":
        options.base = requireValue(args, i, arg);
        i += 1;
        break;
      case "--provider": {
        const value = requireValue(args, i, arg);
        if (!JEV_PROVIDERS.includes(value as JevProvider)) {
          throw new Error("--provider must be one of: " + JEV_PROVIDERS.join(", "));
        }
        options.provider = value as JevProvider;
        i += 1;
        break;
      }
      case "--model":
        options.model = requireValue(args, i, arg);
        i += 1;
        break;
      case "--no-cache":
        options.cache = false;
        break;
      case "--record":
        options.testRecord = true;
        break;
      case "--drift":
        options.testDrift = true;
        break;
      case "--sample-size": {
        const value = Number(requireValue(args, i, arg));
        if (!Number.isInteger(value) || value < 1) {
          throw new Error("--sample-size must be a positive integer");
        }
        options.sampleSize = value;
        options.sampleSizeSet = true;
        i += 1;
        break;
      }
      case "-h":
      case "--help":
        console.log(usage());
        process.exit(0);
        break;
      default:
        if (arg.startsWith("-")) throw new Error("unknown option: " + arg);
        options.patterns.push(arg);
    }
  }

  if (options.changed && options.staged) throw new Error("choose either --changed or --staged");
  if (options.base && !options.changed) throw new Error("--base requires --changed");
  if (options.format === "sarif" && options.command !== "check" && options.command !== "replay") {
    throw new Error("--format sarif is only valid for check or replay");
  }
  if (options.command === "replay" && (options.provider || options.model)) {
    throw new Error("replay is offline; --provider and --model are not valid");
  }
  if (
    options.command === "rules-audit" &&
    (options.changed || options.staged || options.base || options.patterns.length > 0)
  ) {
    throw new Error("rules audit does not accept file patterns, --changed, --staged, or --base");
  }
  if ((options.testRecord || options.testDrift) && options.command !== "test") {
    throw new Error("--record and --drift are only valid with test");
  }
  if (options.testRecord && options.testDrift) {
    throw new Error("choose either test --record or test --drift");
  }
  if (options.sampleSizeSet && options.command !== "recall") {
    throw new Error("--sample-size is only valid with recall");
  }
  if (options.command === "recall" && options.staged) {
    throw new Error("recall operates on working-tree files; --staged is not supported");
  }
  return options;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig(args.config);

  const modelNamespace = [
    args.provider ?? process.env.JEV_PROVIDER ?? "typesafe",
    args.model ?? process.env.JEV_MODEL ?? "default",
  ].join(":");

  if (args.command === "list") {
    const value = config.rules.map((rule) => ({
      id: rule.id,
      status: rule.status ?? "shadow",
      severity: rule.severity ?? "error",
      threshold: rule.threshold ?? 0.8,
      source: rule.source,
      mutants: rule.mutants?.length ?? 0,
      candidate: rule.ast ? "ast" : rule.wholeFile ? "whole-file" : rule.prefilter ? "prefilter" : "chunks",
    }));
    console.log(
      args.format === "json"
        ? formatJson(value)
        : value
            .map(
              (rule) =>
                rule.status.padEnd(6) +
                "  " +
                rule.severity.padEnd(7) +
                "  " +
                rule.id +
                "  threshold=" +
                rule.threshold +
                "  candidate=" +
                rule.candidate +
                "  mutants=" +
                rule.mutants,
            )
            .join("\n"),
    );
    return;
  }

  const calibrationFile = resolve(config.calibrationFile ?? DEFAULT_CALIBRATION_FILE);
  const evidenceFile = resolve(config.evidenceFile ?? DEFAULT_EVIDENCE_FILE);

  if (args.command === "rules-audit") {
    const evaluated = await evaluateConfiguredRuleEvidence(config, { modelNamespace });
    console.log(
      args.format === "json"
        ? formatJson(evaluated.reports)
        : formatRuleEvidenceStylish(evaluated.reports),
    );
    return;
  }
  const recordedCalibration =
    args.command === "test" && args.testDrift
      ? await readCalibration(calibrationFile)
      : undefined;

  const hasOwnedRules = config.rules.some((rule) => (rule.status ?? "shadow") === "owned");
  const ruleEvidenceReports =
    (args.command === "check" || args.command === "replay") && hasOwnedRules
      ? (await evaluateConfiguredRuleEvidence(config, { modelNamespace })).reports
      : undefined;

  const baselineFile = resolve(config.baselineFile ?? DEFAULT_BASELINE_FILE);
  const baseline =
    args.command === "check" || args.command === "replay"
      ? await readBaseline(baselineFile)
      : [];
  const replayFile = resolve(config.replayFile ?? DEFAULT_REPLAY_FILE);
  const decisionStore =
    args.command === "record"
      ? new DiskSemanticDecisionStore(replayFile)
      : args.command === "replay"
        ? new DiskSemanticDecisionStore(replayFile, true)
        : undefined;
  const client =
    args.command === "replay"
      ? undefined
      : createJevClient({ provider: args.provider, model: args.model });
  const cacheFile = resolve(config.cacheFile ?? ".jevcheck/cache.json");
  const cache =
    args.cache &&
    args.command !== "replay" &&
    !(args.command === "test" && (args.testRecord || args.testDrift))
      ? new DiskAnswerCache(cacheFile)
      : undefined;
  const checker = createJevCheck({
    client,
    rules: config.rules,
    cache,
    cacheNamespace: modelNamespace,
    chunkChars: config.chunkChars,
    overlapLines: config.overlapLines,
    contextLines: config.contextLines,
    baseline,
    suppressionMarker: config.suppressionMarker,
    decisionStore,
    replayOnly: args.command === "replay",
    mode: args.command === "check" || args.command === "replay" ? "enforce" : "measure",
    ruleEvidenceReports,
  });

  if (args.command === "test") {
    const result = await checker.testFixtures();
    const fixtureFailed =
      result.tests.some((test) => !test.passed) ||
      result.diagnostics.some((item) => item.level === "error");
    let recorded: { file: string; fixtures: number } | undefined;
    let drift;

    const calibrationReady =
      result.tests.length > 0 &&
      result.tests.every((test) => test.semanticKeys.length > 0);

    if (args.testRecord && !fixtureFailed && calibrationReady) {
      recorded = {
        file: calibrationFile,
        fixtures: await writeCalibration(calibrationFile, result.tests),
      };
    } else if (args.testDrift) {
      drift = compareCalibration(
        recordedCalibration!,
        result.tests,
        config.driftThreshold ?? undefined,
      );
      const current = await collectCurrentFixtureEvidence(config.rules, {
        chunkChars: config.chunkChars,
        overlapLines: config.overlapLines,
        contextLines: config.contextLines,
      });
      await persistDriftEvidence(
        evidenceFile,
        config.rules,
        current.fixtures,
        recordedCalibration!,
        result,
        drift,
        config.driftThreshold ?? drift.driftThreshold,
        modelNamespace,
      );
    }

    if (args.format === "json") {
      console.log(formatJson({
        ...result,
        ...(recorded ? { recorded } : {}),
        ...(args.testRecord && !recorded
          ? {
              calibrationNotRecorded: fixtureFailed
                ? "fixture failures"
                : result.tests.length === 0
                  ? "no fixtures"
                  : "fixtures with no semantic evaluations",
            }
          : {}),
        ...(drift ? { drift, evidenceFile } : {}),
      }));
    } else {
      const sections = [formatFixtureStylish(result)];
      if (recorded) {
        sections.push(
          "Recorded " +
            recorded.fixtures +
            " fixture probability/probabilities to " +
            recorded.file,
        );
      } else if (args.testRecord) {
        sections.push(
          "Calibration not recorded: " +
            (fixtureFailed
              ? "fixture failures must be fixed first."
              : result.tests.length === 0
                ? "no fixtures were evaluated."
                : "every fixture must produce at least one semantic evaluation."),
        );
      }
      if (drift) {
        sections.push(formatFixtureDriftStylish(drift));
        sections.push("Recorded current drift evidence to " + evidenceFile);
      }
      console.log(sections.join("\n\n"));
    }

    const driftFailed =
      drift !== undefined &&
      (drift.moved.length > 0 ||
        drift.stale.length > 0 ||
        drift.added.length > 0 ||
        drift.removed.length > 0);
    process.exitCode =
      fixtureFailed ||
      (args.testRecord && !recorded) ||
      driftFailed
        ? 1
        : 0;
    return;
  }

  const includes = config.include ?? DEFAULT_SOURCE_INCLUDE;
  let paths: string[];
  let stagedInputs: SourceInput[] | undefined;
  if (args.staged) {
    const staged = await stagedSources();
    paths = filterFiles(
      staged.map((item) => item.path),
      includes,
      config.exclude ?? [],
    );
    const byPath = new Map(staged.map((item) => [item.path.replaceAll("\\", "/"), item]));
    stagedInputs = paths.map((path) => byPath.get(path)).filter((item): item is SourceInput => item !== undefined);
  } else if (args.changed) {
    paths = filterFiles(await changedFiles(args.base), includes, config.exclude ?? []);
  } else {
    paths = await discoverFiles(args.patterns.length ? args.patterns : includes, config.exclude ?? []);
  }

  if (args.command === "recall") {
    const result = await checker.recallFiles(paths, args.sampleSize);
    const fullScope =
      !args.changed &&
      !args.staged &&
      !args.base &&
      args.patterns.length === 0;

    if (fullScope) {
      await persistMutationEvidence(
        evidenceFile,
        config.rules,
        result,
        paths,
        args.sampleSize,
        {
          chunkChars: config.chunkChars,
          overlapLines: config.overlapLines,
          contextLines: config.contextLines,
          include: includes,
          exclude: config.exclude ?? [],
          modelNamespace,
        },
      );
    }

    if (args.format === "json") {
      console.log(formatJson({
        ...result,
        ...(fullScope
          ? { evidenceFile }
          : { evidenceNotRecorded: "scoped recall runs are not graduation evidence" }),
      }));
    } else {
      const suffix = fullScope
        ? "\nRecorded current mutation recall evidence to " + evidenceFile
        : "\nMutation evidence not recorded: scoped recall runs are exploratory only.";
      console.log(formatRecallStylish(result) + suffix);
    }
    process.exitCode = result.diagnostics.some((item) => item.level === "error") ? 1 : 0;
    return;
  }

  if (!paths.length) {
    const empty = {
      findings: [],
      suppressedFindings: [],
      evaluations: [],
      diagnostics: [],
      stats: {
        filesChecked: 0,
        candidatesChecked: 0,
        requests: 0,
        cacheHits: 0,
        replayHits: 0,
        replayMisses: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    };
    console.log(
      args.format === "json" ? formatJson(empty) : args.format === "sarif" ? formatSarif(empty) : "No files matched.",
    );
    return;
  }

  const result = stagedInputs ? await checker.checkSources(stagedInputs) : await checker.checkFiles(paths);

  if (args.command === "record") {
    await decisionStore?.flush?.();
    const decisions = await decisionStore?.count?.() ?? result.evaluations.length;
    console.log(
      args.format === "json"
        ? formatJson({ ...result, replay: { file: replayFile, decisions } })
        : formatStylish(result) +
          "\nReplay corpus: " +
          decisions +
          " decision(s) in " +
          replayFile,
    );
    process.exitCode = result.diagnostics.some((item) => item.level === "error") ? 1 : 0;
    return;
  }

  if (args.command === "baseline") {
    const entries = result.findings.map(baselineEntry);
    const evaluatedScopes = new Set<string>();
    for (const path of paths) {
      for (const rule of config.rules) {
        if (ruleAppliesToFile(rule, path)) {
          evaluatedScopes.add(baselineScopeKey(rule.id, path));
        }
      }
    }
    const total = await writeBaseline(baselineFile, evaluatedScopes, entries);
    console.log(
      args.format === "json"
        ? formatJson({ baselineFile, entriesWritten: entries.length, totalEntries: total })
        : "Updated " + baselineFile + " with " + entries.length + " current finding(s); " + total + " total baseline entry(s).",
    );
    return;
  }

  console.log(
    args.format === "json"
      ? formatJson(result)
      : args.format === "sarif"
        ? formatSarif(result)
        : formatStylish(result),
  );
  process.exitCode =
    result.findings.some((finding) => finding.blocking) ||
    result.stats.replayMisses > 0 ||
    result.diagnostics.some((item) => item.level === "error")
      ? 1
      : 0;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
