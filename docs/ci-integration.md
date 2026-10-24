# CI integration: GitHub Actions and Azure Pipelines

Start with the provider-free `inspect` / `rules audit` path. Turn on a
semantic check **only after** security approves the chosen provider and rules
are qualified for the intended enforcement mode. These templates need neither
a hosted app nor webhooks.

| Consumer | Copyable workflow | Provider-free fixture |
| --- | --- | --- |
| GitHub Actions | [`examples/ci/github-actions.yml`](../examples/ci/github-actions.yml) → `.github/workflows/jevcheck.yml` | [`examples/ci/sample/`](../examples/ci/sample/) |
| Azure Pipelines | [`examples/ci/azure-pipelines.yml`](../examples/ci/azure-pipelines.yml) → `azure-pipelines-jevcheck.yml` | Same fixture |

## Minimal setup

1. Use Node.js 20+ (examples use 24). Add `@mhingston5/jevcheck`
   as a **pinned, reviewed dev dependency** in the consumer's
   `package.json` and commit its `package-lock.json`:
   `npm install --save-dev --save-exact @mhingston5/jevcheck`.
   The recipes use `npm ci` and `npx --no-install`; they do not fetch
   a CLI ad hoc.
2. Put a reviewed `jevcheck.config.json` at the repository root. To try
   without credentials, copy the [sample config](../examples/ci/sample/jevcheck.config.json)
   and [sample source](../examples/ci/sample/src/handler.ts) to the
   consumer root paths `jevcheck.config.json` and `src/handler.ts`.
   The sample is deliberately a **shadow** rule with no calibration or
   claims of classification accuracy. Replace its scope, question and
   fixture with an invariant the team actually owns.
3. Copy one workflow. GitHub Actions uses a `pull_request` trigger and
   full-depth PR **merge-commit** checkout; the checked-out `HEAD` must
   equal `GITHUB_SHA`. It fetches `refs/heads/<base>` to
   `refs/remotes/origin/<base>`. Do not substitute `head.sha` without
   accounting for GitHub's separate merge `GITHUB_SHA` provenance.
   Azure Pipelines uses `checkout: self` with `fetchDepth: 0`,
   confirms `HEAD == Build.SourceVersion`, and fetches
   `System.PullRequest.TargetBranch`. **Azure Repos PR validation
   requires a branch-policy build validation entry**; its YAML `pr:`
   trigger only applies when that trigger is supported (e.g. GitHub).
   For private Azure Repos, `persistCredentials: true` permits this
   fetch with the scoped, ephemeral Build Service token. Grant repository
   read access only; the PR job should not need write access or a PAT.
4. For the optional provider-backed check, configure a CI **secret**
   `TYPESAFE_API_KEY` and explicitly opt in with GitHub repository variable
   `JEV_ENABLE_SEMANTIC_CHECK=true` or Azure pipeline variable
   `JEV_ENABLE_SEMANTIC_CHECK=true`. A missing enabled secret **fails**;
   it never silently reports a semantic pass. To use another approved
   provider, update the step's secret mapping and `JEV_PROVIDER` as
   documented in the [provider reference](reference.md#provider-configuration).
   GitHub's opt-in gate deliberately skips fork PRs; define separate
   protection/review rules for them rather than treating skipped checks
   as enforcement. Never use `pull_request_target` to execute untrusted
   PR code with secrets.

## Dry-run: no provider or credentials required

With the example files at the consumer repository root, from that root:

```sh
npm ci
npx --no-install jevcheck inspect --format json
npx --no-install jevcheck rules audit --format json
```

For a PR branch, **first fetch the target branch**, then from its checked-out
PR revision (not an arbitrary local worktree):

```sh
git fetch origin 'refs/heads/main:refs/remotes/origin/main'
npx --no-install jevcheck inspect --changed --base origin/main --format json
npx --no-install jevcheck rules audit --format json
```

Substitute the actual PR target for `main`. `--changed --base` evaluates
the committed **HEAD** source, config and evidence against the merge base,
not uncommitted files. `--changed` without `--base` instead reads the
working tree; `--staged` reads the index. A changed active config expands
diff-mode inspection/checks to the complete new configured source scope:
read `data.selection.mode` and `data.preflight` before allowing paid calls,
especially on config-only PRs. `inspect` returns candidate/request previews,
**not violation judgements**. Its full JSON includes model-visible source:
summarise locally and avoid exposing full requests in public CI logs/artifacts.

`rules audit --format json` is a **readiness report, not a CI pass gate**.
It can return `outcome: "block"` with **exit code 0**, including for
shadow rules missing graduation evidence. To **intentionally** gate on *all*
reported readiness blockers (not recommended for initial advisory adoption),
parse the envelope, rather than trusting exit status:

```sh
set -e
npx --no-install jevcheck rules audit --format json > audit.json
node -e 'const r=JSON.parse(require("node:fs").readFileSync("audit.json","utf8")); if(!["pass","warn"].includes(r.outcome)) process.exit(1)'
```

The shell's `set -e` preserves CLI failures (including exit 2 for config/runtime
errors). Only successful audits with `outcome: "pass"` or `"warn"` pass
this additional readiness policy; blocked, errored or unknown outcomes fail.
This optional policy is stricter than running shadow rules as advisory. Owned
error rules already enforce their evidence gates and fail closed; do not
promote on the audit process status alone.

## Advisory vs blocking, and SARIF

| Mode | CI action | What it proves |
| --- | --- | --- |
| Advisory-only (default) | `inspect --changed --base ... --format json` + `rules audit --format json` | Eligible scope, preflight and evidence-readiness diagnostics; **no semantic check occurred** |
| Semantic advisory (opt-in) | `jevcheck --changed --base ... --format sarif` with qualified provider and **shadow** rules | Actual model findings at note level; not a blocking guarantee |
| Owned/blocking (opt-in) | Same `jevcheck` command with independently qualified **owned/error** rules | Blocking findings / incomplete execution fail the CI step (exit 1); config, evidence or provider errors fail (exit 2) |

Neither YAML recipe uses `continue-on-error` or masks the process status.
Both write SARIF **only** from the optional provider-backed `check` command.
Generating an artifact does not upload it into a code-scanning product. The
GitHub workflow attaches SARIF as a download; if desired, separately add
`github/codeql-action/upload-sarif@v3` and deliberately grant
`security-events: write` (subject to repo/code-scanning policy). The Azure
workflow publishes an ordinary pipeline artifact. Treat code and SARIF
contents as potentially sensitive and review artifact access/retention.

## Reviewed `coveredBy` checks: different trust models

`coveredBy` is **not** a shortcut for passing unit tests. Maintain and
review exact `coveredBy` mappings, run `coverage record --attest-reviewed`
*outside* the PR job and commit reviewed fingerprints. A passing command
cannot establish invariant equivalence by itself.

GitHub Actions is currently the **only** runner with supported same-job
`coverage verify` provenance. For *every* declared check ID, after
checkout/dependency installation, run the reviewed command sequentially:

```sh
npx --no-install jevcheck coverage verify --check unit -- npm test
npx --no-install jevcheck rules audit --format json
npx --no-install jevcheck --format sarif > jevcheck.sarif
```

The `unit` ID and `npm test` are **illustrative**: replace both with
checks declared in your config and confirmed to prove the same invariant.
All verification and enforcement must happen **in the same GitHub Actions
job, attempt and checked-out SHA**. The job's `GITHUB_SHA` must match
`git rev-parse HEAD`; a checkout of a PR head SHA instead of the default
merge commit breaks that agreement unless workflow provenance is adapted.
**Crucially, use working-tree `jevcheck`, not `--changed --base` or
`--staged`, after verification:** snapshot modes intentionally cannot see
the transient CI verification recorded in the working tree. Do not commit
those transient records. If verification is absent, invalid or stale,
owned rules follow the documented semantic fallback/evidence gates.

Azure Pipelines **cannot** assert this trust level today. Do not spoof
`GITHUB_ACTIONS`, `GITHUB_SHA`, or the `GITHUB_RUN_*` metadata.
Azure can still run the normal semantic `jevcheck` gate with an approved
provider, but it cannot claim a trusted same-run `coveredBy` skip.

## Validation and manual handoff

This repository runs `tests/ci-recipes.test.ts` against the **built,
bundled CLI** with an isolated temporary Git fixture: an offline full-scope
`inspect`, branch-diff `inspect` and `rules audit` without provider
keys or model calls. Its Ubuntu CI also parses both YAML files with Ruby's
YAML parser. The recipe smoke tests exercise the *commands and structure*;
they do not execute GitHub/Azure hosted actions, grant secret access, or
certify model judgement quality.

In the consumer repository, complete the manual checks: choose and lock an
approved package version; copy/adjust config and scopes; confirm target refs
and branch policy/permissions; review source-data access and provider
credentials; deliberately enable the optional semantic gate; qualify
owned rules on real labelled cases; inspect artifact permissions and verify
that a deliberately failing owned rule actually fails the protected build.
See [rule lifecycle](rule-lifecycle.md) and
[Git snapshot semantics](reference.md#git-snapshot-semantics).
