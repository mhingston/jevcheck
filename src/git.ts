import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { SourceInput } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

async function gitOutput(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT,
  });
  return stdout;
}

async function gitPaths(args: string[], cwd: string): Promise<string[]> {
  const stdout = await gitOutput([...args, "-z"], cwd);
  return stdout.split("\0").filter((path) => path.length > 0);
}

async function existing(paths: string[], cwd: string): Promise<string[]> {
  const result: string[] = [];
  for (const path of paths) {
    try {
      await access(resolve(cwd, path));
      result.push(path);
    } catch {
      // Deleted working-tree files are intentionally ignored.
    }
  }
  return result;
}

export async function stagedFiles(cwd = process.cwd()): Promise<string[]> {
  return gitPaths(["diff", "--cached", "--name-only", "--diff-filter=ACMR"], cwd);
}

export async function stagedSources(cwd = process.cwd()): Promise<SourceInput[]> {
  const paths = await stagedFiles(cwd);
  return Promise.all(
    paths.map(async (path) => ({
      path,
      source: await gitOutput(["show", ":" + path], cwd),
    })),
  );
}

export async function changedFiles(base: string | undefined, cwd = process.cwd()): Promise<string[]> {
  if (base) {
    return existing(
      await gitPaths(["diff", "--name-only", "--diff-filter=ACMR", base + "...HEAD"], cwd),
      cwd,
    );
  }

  const tracked = await gitPaths(["diff", "--name-only", "--diff-filter=ACMR", "HEAD"], cwd);
  const untracked = await gitPaths(["ls-files", "--others", "--exclude-standard"], cwd);
  return existing(Array.from(new Set([...tracked, ...untracked])).sort(), cwd);
}
