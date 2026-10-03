import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { JevCheckRule, RuleCoverageLink } from "./types.js";

const COVERAGE_IDENTITY_VERSION = "v1";

export interface CoverageLinkFingerprint extends RuleCoverageLink {
  fingerprint: string;
}

export interface CurrentCoverageEvidence {
  ruleId: string;
  identity: string;
  links: CoverageLinkFingerprint[];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function coveragePath(cwd: string, path: string): string {
  if (isAbsolute(path)) throw new Error("coveredBy paths must be repository-relative: " + path);
  const root = resolve(cwd);
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw new Error("coveredBy paths must stay inside the repository: " + path);
  }
  return absolute;
}

export async function currentCoverageEvidence(
  rule: JevCheckRule,
  cwd = process.cwd(),
): Promise<CurrentCoverageEvidence | undefined> {
  if (!rule.coveredBy?.length) return undefined;

  const links: CoverageLinkFingerprint[] = [];
  for (const link of rule.coveredBy) {
    let content: string;
    try {
      content = await readFile(coveragePath(cwd, link.path), "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        "coverage source cannot be read for " + rule.id + " / " + link.id + ": " + link.path + " (" + detail + ")",
      );
    }
    links.push({
      ...link,
      fingerprint: hash(JSON.stringify({ path: link.path, content })),
    });
  }
  links.sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));

  return {
    ruleId: rule.id,
    identity: hash(JSON.stringify({
      version: COVERAGE_IDENTITY_VERSION,
      ruleId: rule.id,
      links,
    })),
    links,
  };
}
