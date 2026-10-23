import { execFile } from "node:child_process";
import { access, chmod, lstat, mkdir, mkdtemp, readlink, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { SourceInput } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const MAX_BLOB_OUTPUT = 64 * 1024 * 1024;

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
  // -z is a Git option, not a pathspec. It must precede "--" when a
  // literal path is selected; otherwise Git silently returns no matches.
  const separator = args.indexOf("--");
  const withNull = separator < 0
    ? [...args, "-z"]
    : [...args.slice(0, separator), "-z", ...args.slice(separator)];
  const stdout = await gitOutput(withNull, cwd);
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
  return gitPaths(["diff", "--cached", "--relative", "--no-renames", "--name-only", "--diff-filter=ACMT"], cwd);
}

export async function stagedSources(cwd = process.cwd()): Promise<SourceInput[]> {
  const paths = await stagedFiles(cwd);
  return Promise.all(
    paths.map(async (path) => ({
      path,
      source: await gitOutput(["show", ":./" + path], cwd),
    })),
  );
}

export async function changedFiles(base: string | undefined, cwd = process.cwd()): Promise<string[]> {
  if (base) {
    // This names files in HEAD, NOT files in the working tree. Do not discard
    // paths based on whether someone has subsequently deleted them locally.
    return gitPaths(["diff", "--relative", "--no-renames", "--name-only", "--diff-filter=ACMT", base + "...HEAD"], cwd);
  }

  const tracked = await gitPaths(["diff", "--relative", "--no-renames", "--name-only", "--diff-filter=ACMT", "HEAD"], cwd);
  const untracked = await gitPaths(["ls-files", "--others", "--exclude-standard"], cwd);
  return existing(Array.from(new Set([...tracked, ...untracked])).sort(), cwd);
}

/**
 * Did the active config change relative to the revision supplying diff inputs?
 * Include deletions even though deleted paths cannot be linted as sources.
 * Restrict Git's pathspec to the literal config path (not a glob).
 */
export async function activeConfigChanged(
  configPath: string,
  mode: "working-tree" | "index" | "head",
  cwd = process.cwd(),
  base?: string,
  selectedCwd = process.cwd(),
): Promise<boolean> {
  const repositoryRoot = (await gitOutput(["rev-parse", "--show-toplevel"], cwd)).trim();
  const relativeCwd = relative(await realpath(repositoryRoot), await realpath(cwd)).replaceAll("\\", "/");
  if (relativeCwd === ".." || relativeCwd.startsWith("../") || isAbsolute(relativeCwd)) {
    throw new Error("active config is outside the Git repository");
  }

  // selectedCwd is the *selected revision*: HEAD/index snapshot or working
  // tree. Never resolve a staged/HEAD symlink through the live checkout.
  const selectedRoot = resolve(selectedCwd, ...relativeCwd.split("/").filter(Boolean).map(() => ".."));
  const selectedRootCanonical = await realpath(selectedRoot);
  const resolvedConfig = await realpath(resolve(selectedCwd, configPath));
  const resolvedPath = relative(selectedRootCanonical, resolvedConfig).replaceAll("\\", "/");
  if (resolvedPath === ".." || resolvedPath.startsWith("../") || isAbsolute(resolvedPath)) {
    throw new Error("active config resolves outside the selected Git revision: " + configPath);
  }

  // Include the config itself, the dereferenced content path, and any symlink
  // ancestors of the configured path. A target-only edit changes effective
  // policy even though the symlink blob is byte-for-byte unchanged.
  const paths = new Set<string>([
    posix.normalize(posix.join(relativeCwd, configPath.replaceAll("\\", "/"))),
    resolvedPath,
  ]);
  const components = configPath.replaceAll("\\", "/").split("/").filter((part) => part && part !== ".");
  let prefix = "";
  for (const component of components) {
    prefix = prefix ? prefix + "/" + component : component;
    if ((await lstat(resolve(selectedCwd, prefix))).isSymbolicLink()) {
      paths.add(posix.normalize(posix.join(relativeCwd, prefix)));
    }
  }

  const diff = ["diff", "--no-renames", "--name-only", "--diff-filter=ACDMT"];
  if (mode === "index") diff.push("--cached"); // HEAD or empty tree on an unborn branch.
  else if (mode === "head") {
    if (!base) throw new Error("HEAD comparison requires --base");
    diff.push(base + "...HEAD");
  } else diff.push("HEAD");

  const literals = [...paths].map((path) => ":(literal)" + path);
  if ((await gitPaths([...diff, "--", ...literals], repositoryRoot)).some((path) => paths.has(path))) {
    return true;
  }
  // Git diff omits untracked working-tree configs and resolved targets.
  return mode === "working-tree" &&
    (await gitPaths(["ls-files", "--others", "--exclude-standard", "--", ...literals], repositoryRoot))
      .some((path) => paths.has(path));
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
 * Raw object blobs are materialized without autocrlf or smudge filters.
 * For HEAD we populate an isolated index with read-tree first: neither case
 * touches the real index or checkout. All readers (config, manifests, ADR,
 * fixtures, calibration, coverage, source) use the SAME byte-exact tree.
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
    await materializeBlobs(repositoryRoot, checkout, env);
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

/**
 * Materialize stage-0 blob contents rather than checkout-converted text.
 * Bound concurrency and blob size instead of buffering the whole repository.
 */
async function materializeBlobs(
  repositoryRoot: string,
  checkout: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const raw = await gitOutput(["ls-files", "--stage", "-z"], repositoryRoot, env);
  const entries = raw.split("\0").filter(Boolean).map((record) => {
    const match = /^(\d+) ([0-9a-f]{40,64}) ([0-3])\t([\s\S]+)$/.exec(record);
    if (!match || match[3] !== "0") {
      throw new Error("Git snapshot cannot materialize an unresolved index entry");
    }
    return { mode: match[1]!, sha: match[2]!, path: match[4]! };
  });

  for (const entry of entries) {
    const dest = resolve(checkout, entry.path);
    if (dest === checkout || !dest.startsWith(checkout + sep)) {
      throw new Error("unsafe Git snapshot path: " + entry.path);
    }
  }

  let next = 0;
  const workers = Array.from({ length: Math.min(entries.length, 8) }, async () => {
    while (next < entries.length) {
      const entry = entries[next++]!;
      if (entry.mode === "160000") continue; // Submodule gitlink, not a file blob.
      if (!["100644", "100755", "120000"].includes(entry.mode)) {
        throw new Error("unsupported Git snapshot mode: " + entry.mode + " (" + entry.path + ")");
      }
      const destination = resolve(checkout, entry.path);
      await mkdir(dirname(destination), { recursive: true });
      const { stdout } = await execFileAsync("git", ["cat-file", "blob", entry.sha], {
        cwd: repositoryRoot,
        encoding: "buffer",
        maxBuffer: MAX_BLOB_OUTPUT,
      });
      if (entry.mode === "120000") {
        const target = stdout.toString("utf8");
        const resolved = resolve(dirname(destination), target);
        if (isAbsolute(target) || (resolved !== checkout && !resolved.startsWith(checkout + sep))) {
          throw new Error("Git snapshot contains a symlink outside the revision: " + entry.path);
        }
        await symlink(target, destination);
      } else {
        await writeFile(destination, stdout);
        if (entry.mode === "100755") await chmod(destination, 0o755);
      }
    }
  });
  await Promise.all(workers);
}

async function rejectExternalSymlinks(root: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        // Lexical normalization is insufficient: alias -> "." together with a
        // target of "alias/../outside.json" can escape through the symlink.
        // Resolve the *actual* target only after all blobs are present.
        let canonicalTarget: string;
        try {
          canonicalTarget = await realpath(path);
        } catch {
          throw new Error("Git snapshot contains an unresolved symlink: " + relative(root, path));
        }
        if (
          isAbsolute(target) ||
          (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(canonicalRoot + sep))
        ) {
          throw new Error("Git snapshot contains a symlink outside the revision: " + relative(root, path));
        }
      }
    }
  }
  await visit(root);
}
