#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { projectSpecForge } from "./specforge.js";

async function main(args: string[]): Promise<void> {
  const paths = new Map<string, string>();
  let check = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--check") {
      if (check) throw new Error("--check specified twice");
      check = true;
      continue;
    }
    if (!["--graph", "--mapping", "--output"].includes(arg) ||
        paths.has(arg) || !args[i + 1] || args[i + 1]!.startsWith("--")) {
      throw new Error("Usage: jevcheck-specforge --graph <graph.json> --mapping <mapping.json> --output <jevcheck.json> [--check]");
    }
    paths.set(arg, args[++i]!);
  }
  for (const flag of ["--graph", "--mapping", "--output"]) {
    if (!paths.has(flag)) throw new Error("missing " + flag);
  }

  const graph = JSON.parse(await readFile(paths.get("--graph")!, "utf8")) as unknown;
  const mapping = JSON.parse(await readFile(paths.get("--mapping")!, "utf8")) as unknown;
  const output = JSON.stringify(projectSpecForge(graph, mapping), null, 2) + "\n";
  const target = paths.get("--output")!;
  if (check) {
    if (await readFile(target, "utf8") !== output) {
      throw new Error("projected config is stale: regenerate " + target);
    }
    console.log("SpecForge projection matches " + target);
  } else {
    await writeFile(target, output, "utf8");
    console.log("Wrote " + target + " (shadow rules only)");
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error("jevcheck-specforge: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 2;
});
