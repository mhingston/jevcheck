import { discoverFiles, filterFiles } from "./files.js";
import { activeConfigChanged, changedFiles, stagedFiles } from "./git.js";
import { DEFAULT_SOURCE_INCLUDE } from "./evidence-store.js";
import type { JevCheckConfig } from "./types.js";

export interface SourceSelection {
  mode: "full" | "diff" | "full-policy-change";
  changedConfig?: string;
  selectedFiles: number;
}

export interface SelectedSources {
  paths: string[];
  selection: SourceSelection;
}

/**
 * A config-only change can alter the scope and meaning of every rule.
 * In that case, select the full current policy scope from the SAME source
 * revision as the config, then use the existing rule/policy machinery.
 */
export async function selectSources(
  args: {
    changed: boolean;
    staged: boolean;
    base?: string;
    config: string;
    patterns: string[];
  },
  config: JevCheckConfig,
  gitCwd: string,
): Promise<SelectedSources> {
  const include = config.include ?? DEFAULT_SOURCE_INCLUDE;
  const exclude = config.exclude ?? [];
  if (args.changed || args.staged) {
    const mode = args.staged ? "index" : args.base ? "head" : "working-tree";
    const policyChanged = await activeConfigChanged(args.config, mode, gitCwd, args.base);
    if (policyChanged) {
      const paths = await discoverFiles(include, exclude);
      return {
        paths,
        selection: { mode: "full-policy-change", changedConfig: args.config, selectedFiles: paths.length },
      };
    }
    const changed = args.staged ? await stagedFiles(gitCwd) : await changedFiles(args.base, gitCwd);
    const paths = filterFiles(changed, include, exclude);
    return { paths, selection: { mode: "diff", selectedFiles: paths.length } };
  }
  const paths = await discoverFiles(args.patterns.length ? args.patterns : include, exclude);
  return { paths, selection: { mode: "full", selectedFiles: paths.length } };
}

export function selectionNotice(selection: SourceSelection): string {
  return selection.mode === "full-policy-change"
    ? "Active config changed (" + selection.changedConfig + "): scanning full current policy scope (" +
      selection.selectedFiles + " source file(s))."
    : "";
}
