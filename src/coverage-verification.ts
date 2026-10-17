import { execFileSync } from "node:child_process";

export interface GithubActionsProvenance {
  provider: "github-actions";
  sha: string;
  runId: string;
  attempt: string;
  job: string;
}

export interface CoverageCheckResult {
  id: string;
  status: "passed" | "failed";
}

export interface CoverageRunVerification {
  provenance: GithubActionsProvenance;
  checks: CoverageCheckResult[];
}

/**
 * Only a trusted GitHub Actions workflow is an acceptable execution context.
 * This validates runner-provided metadata and the checked-out HEAD; it does NOT
 * independently authenticate a GitHub check run or prove semantic coverage.
 */
export function currentGithubActionsRun(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): GithubActionsProvenance | undefined {
  const sha = env.GITHUB_SHA?.toLowerCase();
  const runId = env.GITHUB_RUN_ID;
  const attempt = env.GITHUB_RUN_ATTEMPT;
  const job = env.GITHUB_JOB;
  if (
    env.GITHUB_ACTIONS !== "true" ||
    !sha || !/^[0-9a-f]{40}$/.test(sha) ||
    !runId || !/^[1-9]\d*$/.test(runId) ||
    !attempt || !/^[1-9]\d*$/.test(attempt) ||
    !job || !/^[a-zA-Z0-9_-]+$/.test(job)
  ) return undefined;

  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim().toLowerCase();
    if (head !== sha) return undefined;
  } catch {
    return undefined;
  }
  return { provider: "github-actions", sha, runId, attempt, job };
}

export function sameGithubActionsRun(
  left: GithubActionsProvenance,
  right: GithubActionsProvenance,
): boolean {
  return left.provider === right.provider &&
    left.sha === right.sha &&
    left.runId === right.runId &&
    left.attempt === right.attempt &&
    left.job === right.job;
}
