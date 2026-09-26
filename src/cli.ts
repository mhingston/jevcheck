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
import { discoverFiles, filterFiles } from "./files.js";
import {
  formatFixtureDriftStylish,
  formatFixtureStylish,
  formatJson,
  formatSarif,
  formatStylish,
} from "./format.js";
import { changedFiles, stagedSources } from "./git.js";
import { DEFAULT_REPLAY_FILE, DiskSemanticDecisionStore } from "./replay.js";
import type { SourceInput } from "./types.js";

type Command = "check" | "test" | "list" | "baseline" | "record" | "replay";
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
  patterns: string[];
}

const DEFAULT_INCLUDE = [
  "**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts,py,go,rs,java,cs,rb,php,vue,svelte}",
];

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
    "  -h, --help            Show help",
    "",
    "record captures semantic decisions to replayFile (default: .jevcheck/replay.json).",
    "replay is strict and offline: missing decisions are errors and never reach a provider.",
    "test --record writes calibrationFile; test --drift bypasses the answer cache.",
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
  if (
    args[0] === "test" ||
    args[0] === "list" ||
    args[0] === "baseline" ||
    args[0] === "record" ||
    args[0] === "replay"
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
  if ((options.testRecord || options.testDrift) && options.command !== "test") {
    throw new Error("--record and --drift are only valid with test");
  }
  if (options.testRecord && options.testDrift) {
    throw new Error("choose either test --record or test --drift");
  }
  return options;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig(args.config);

  if (args.command === "list") {
    const value = config.rules.map((rule) => ({
      id: rule.id,
      status: rule.status ?? "shadow",
      severity: rule.severity ?? "error",
      threshold: rule.threshold ?? 0.8,
      source: rule.source,
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
                rule.candidate,
            )
            .join("\n"),
    );
    return;
  }

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
    !(args.command === "test" && args.testDrift)
      ? new DiskAnswerCache(cacheFile)
      : undefined;
  const checker = createJevCheck({
    client,
    rules: config.rules,
    cache,
    cacheNamespace: [
      args.provider ?? process.env.JEV_PROVIDER ?? "typesafe",
      args.model ?? process.env.JEV_MODEL ?? "default",
    ].join(":"),
    chunkChars: config.chunkChars,
    overlapLines: config.overlapLines,
    contextLines: config.contextLines,
    baseline,
    suppressionMarker: config.suppressionMarker,
    decisionStore,
    replayOnly: args.command === "replay",
  });

  if (args.command === "test") {
    const result = await checker.testFixtures();
    const calibrationFile = resolve(config.calibrationFile ?? DEFAULT_CALIBRATION_FILE);
    let recorded: { file: string; fixtures: number } | undefined;
    let drift;

    if (args.testRecord) {
      recorded = {
        file: calibrationFile,
        fixtures: await writeCalibration(calibrationFile, result.tests),
      };
    } else if (args.testDrift) {
      drift = compareCalibration(await readCalibration(calibrationFile), result.tests);
    }

    if (args.format === "json") {
      console.log(formatJson({
        ...result,
        ...(recorded ? { recorded } : {}),
        ...(drift ? { drift } : {}),
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
      }
      if (drift) sections.push(formatFixtureDriftStylish(drift));
      console.log(sections.join("\n\n"));
    }

    const failed =
      result.tests.some((test) => !test.passed) ||
      result.diagnostics.some((item) => item.level === "error");
    process.exitCode = failed ? 1 : 0;
    return;
  }

  const includes = config.include ?? DEFAULT_INCLUDE;
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
