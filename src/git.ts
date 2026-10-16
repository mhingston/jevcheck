import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readlink, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { SourceInput } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

async function gitOutput(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env,
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
  // Treat renames as an added destination (and a deleted source). The old path
  // is not a source in the index. Include file type changes as well.
  return gitPaths(["diff", "--cached", "--no-renames", "--name-only", "--diff-filter=ACMT"], cwd);
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
    // This names files in HEAD, NOT files in the working tree. Do not discard
    // paths based on whether someone has subsequently deleted them locally.
    return gitPaths(["diff", "--no-renames", "--name-only", "--diff-filter=ACMT", base + "...HEAD"], cwd);
  }

  const tracked = await gitPaths(["diff", "--no-renames", "--name-only", "--diff-filter=ACMT", "HEAD"], cwd);
  const untracked = await gitPaths(["ls-files", "--others", "--exclude-standard"], cwd);
  return existing(Array.from(new Set([...tracked, ...untracked])).sort(), cwd);
}

export interface GitEvaluationSnapshot {
  /** Temporary directory containing the checkout; delete it with dispose(). */
  root: string;
  /** Equivalent of the calling working directory within the checkout. */
  cwd: string;
  dispose(): Promise<void>;
}

/**
 * Materialize a *single Git revision* as a read-only input workspace.
 *
 * checkout-index reads blobs from the index, not the user's working tree.
 * For HEAD we populate an isolated index with read-tree first: neither case
 * touches the real index or checkout. This lets every existing reader (config,
 * manifests, ADR, fixtures, calibration, coverage, source) use the SAME tree.
 *
 * Deliberately fail closed for external symlinks: an index symlink must not
 * redirect an evidence/config read into the live checkout or another directory.
 */
export async function checkoutGitSnapshot(
  revision: "index" | "head",
  cwd = process.cwd(),
): Promise<GitEvaluationSnapshot> {
  const repositoryRoot = (await gitOutput(["rev-parse", "--show-toplevel"], cwd)).trim();
  // Git may return /private/var on macOS for Node's /var, or a short
  // 8.3 directory name on Windows. Canonicalize BOTH paths before taking
  // their relative difference, or join(checkout, relativeCwd) could escape
  // the snapshot and read the user's live working tree.
  const relativeCwd = relative(await realpath(repositoryRoot), await realpath(cwd));
  if (isAbsolute(relativeCwd) || relativeCwd === ".." || relativeCwd.startsWith(".." + sep)) {
    throw new Error("Git snapshot working directory is outside the repository");
  }
  const temporary = await mkdtemp(join(tmpdir(), "jevcheck-snapshot-"));
  const checkout = join(temporary, "checkout");
  try {
    await mkdir(checkout);
    const env = revision === "head"
      ? { ...process.env, GIT_INDEX_FILE: join(temporary, "head.index") }
      : process.env;
    if (revision === "head") {
      await gitOutput(["read-tree", "HEAD"], repositoryRoot, env);
    } else if ((await gitOutput(["ls-files", "--unmerged"], repositoryRoot)).length) {
      throw new Error("--staged requires an index without unresolved merge conflicts");
    }
    // Git's --prefix requires a trailing slash and accepts forward-slash paths
    // on Windows. Only tracked blobs are materialized; ignored/untracked files
    // are intentionally absent from the evaluation.
    await gitOutput(
      ["checkout-index", "--all", "--force", "--prefix=" + checkout.replaceAll("\\", "/") + "/"],
      repositoryRoot,
      env,
    );
    await rejectExternalSymlinks(checkout);
    return {
      root: temporary,
      cwd: join(checkout, relativeCwd),
      dispose: () => rm(temporary, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function rejectExternalSymlinks(root: string): Promise<void> {
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        const absolute = resolve(directory, target);
        if (isAbsolute(target) || (absolute !== root && !absolute.startsWith(root + sep))) {
          throw new Error("Git snapshot contains a symlink outside the revision: " + relative(root, path));
        }
      }
    }
  }
  await visit(root);
}
