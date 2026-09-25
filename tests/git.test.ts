import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { stagedFiles, stagedSources } from "../src/git.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

describe("git scopes", () => {
  it("reads staged content from the index rather than the working tree", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-git-"));
    await git(cwd, ["init", "-q"]);
    await mkdir(join(cwd, "src"), { recursive: true });
    const path = join(cwd, "src", "a.ts");

    await writeFile(path, "staged\n");
    await git(cwd, ["add", "src/a.ts"]);
    await writeFile(path, "working-tree\n");

    const sources = await stagedSources(cwd);
    expect(sources).toEqual([{ path: "src/a.ts", source: "staged\n" }]);
  });

  it("preserves unusual staged filenames without trimming them", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevcheck-git-"));
    await git(cwd, ["init", "-q"]);
    const filename = " leading.ts";

    await writeFile(join(cwd, filename), "const x = 1;\n");
    await git(cwd, ["add", "--", filename]);

    expect(await stagedFiles(cwd)).toEqual([filename]);
  });
});
