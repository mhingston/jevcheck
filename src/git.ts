import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function gitLines(args: string[], cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function existing(paths: string[], cwd: string): Promise<string[]> {
  const result: string[] = [];
  for (const path of paths) {
    try {
      await access(resolve(cwd, path));
      result.push(path);
    } catch {
      // Deleted files are intentionally ignored.
    }
  }
  return result;
}

export async function stagedFiles(cwd = process.cwd()): Promise<string[]> {
  return existing(await gitLines(["diff", "--cached", "--name-only", "--diff-filter=ACMR"], cwd), cwd);
}

export async function changedFiles(base: string | undefined, cwd = process.cwd()): Promise<string[]> {
  if (base) {
    return existing(await gitLines(["diff", "--name-only", "--diff-filter=ACMR", base + "...HEAD"], cwd), cwd);
  }

  const tracked = await gitLines(["diff", "--name-only", "--diff-filter=ACMR", "HEAD"], cwd);
  const untracked = await gitLines(["ls-files", "--others", "--exclude-standard"], cwd);
  return existing(Array.from(new Set([...tracked, ...untracked])).sort(), cwd);
}
