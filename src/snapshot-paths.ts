import { isAbsolute, win32 } from "node:path";
import { isLocalRuleSource } from "./architecture-decision.js";
import type { JevCheckConfig } from "./types.js";

/**
 * Git snapshot readers must never accept policy paths or file patterns that
 * resolve outside the materialized revision. This validation runs BEFORE
 * reading applicability, fixtures, or persisted evidence.
 */
export function assertSnapshotPaths(config: JevCheckConfig): void {
  const paths = [
    config.baselineFile, config.replayFile, config.calibrationFile,
    config.confirmationFile, config.evidenceFile, config.cacheFile,
    ...(config.include ?? []), ...(config.exclude ?? []),
    ...config.rules.flatMap((rule) => [
      ...(rule.files ?? []), ...(rule.exclude ?? []),
      ...(rule.fixtures?.valid ?? []), ...(rule.fixtures?.invalid ?? []),
      ...(rule.fixtures?.confirmation?.valid ?? []),
      ...(rule.fixtures?.confirmation?.invalid ?? []),
      ...(rule.coveredBy ?? []).map((link) => link.path),
    ]),
    // Provenance trims the local source path before calling resolve(). Apply
    // that same normalization here or " /tmp/live.md" bypasses containment.
    ...config.rules.filter((rule) => isLocalRuleSource(rule.source))
      .map((rule) => rule.source!.split("#", 1)[0]!.trim()),
  ];

  for (const path of paths) {
    if (!path) continue;
    const normalized = path.replaceAll("\\", "/");
    if (
      isAbsolute(path) || win32.isAbsolute(path) ||
      /^[A-Za-z]:/.test(path) ||
      normalized.split("/").includes("..")
    ) {
      throw new Error("Git snapshots require repository-relative policy paths: " + path);
    }
  }
}
