#!/usr/bin/env node
import { resolve } from "node:path";
import { createJevClient, JEV_PROVIDERS, type JevProvider } from "@mhingston5/jev-cli";
import { DiskAnswerCache } from "./cache.js";
import { loadConfig } from "./config.js";
import { createJevCheck } from "./engine.js";
import { discoverFiles, filterFiles } from "./files.js";
import { formatFixtureStylish, formatJson, formatStylish } from "./format.js";
import { changedFiles, stagedFiles } from "./git.js";

type Command = "check" | "test" | "list";
type OutputFormat = "stylish" | "json";

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
    "",
    "Options:",
    "  --config <path>       Config file (default: jevcheck.config.json)",
    "  --changed             Check working-tree changes and untracked files",
    "  --staged              Check staged files",
    "  --base <ref>          With --changed, check base...HEAD",
    "  --format <style>      stylish or json",
    "  --provider <name>     Jev provider inherited from @mhingston5/jev-cli",
    "  --model <name>        Override the provider model",
    "  --no-cache            Disable the answer cache",
    "  -h, --help            Show help",
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
  if (args[0] === "test" || args[0] === "list") command = args.shift() as Command;

  const options: CliOptions = {
    command,
    config: "jevcheck.config.json",
    format: "stylish",
    changed: false,
    staged: false,
    cache: true,
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
        if (value !== "stylish" && value !== "json") throw new Error("--format must be stylish or json");
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
                rule.threshold,
            )
            .join("\n"),
    );
    return;
  }

  const client = createJevClient({ provider: args.provider, model: args.model });
  const cacheFile = resolve(config.cacheFile ?? ".jevcheck/cache.json");
  const cache = args.cache ? new DiskAnswerCache(cacheFile) : undefined;
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
  });

  if (args.command === "test") {
    const result = await checker.testFixtures();
    console.log(args.format === "json" ? formatJson(result) : formatFixtureStylish(result));
    const failed =
      result.tests.some((test) => !test.passed) ||
      result.diagnostics.some((item) => item.level === "error");
    process.exitCode = failed ? 1 : 0;
    return;
  }

  const includes = config.include ?? DEFAULT_INCLUDE;
  let paths: string[];
  if (args.staged) {
    paths = filterFiles(await stagedFiles(), includes, config.exclude ?? []);
  } else if (args.changed) {
    paths = filterFiles(await changedFiles(args.base), includes, config.exclude ?? []);
  } else {
    paths = await discoverFiles(args.patterns.length ? args.patterns : includes, config.exclude ?? []);
  }

  if (!paths.length) {
    console.log(
      args.format === "json"
        ? formatJson({
            findings: [],
            evaluations: [],
            diagnostics: [],
            stats: {
              filesChecked: 0,
              candidatesChecked: 0,
              requests: 0,
              cacheHits: 0,
              inputTokens: 0,
              outputTokens: 0,
            },
          })
        : "No files matched.",
    );
    return;
  }

  const result = await checker.checkFiles(paths);
  console.log(args.format === "json" ? formatJson(result) : formatStylish(result));
  process.exitCode = result.findings.some((finding) => finding.blocking) ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
