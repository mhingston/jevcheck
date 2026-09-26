# jevcheck

Semantic linting for code-review questions a syntax-based linter cannot answer.

jevcheck keeps candidate selection, thresholds, caching, suppressions, CI policy, and rule lifecycle deterministic, then delegates one bounded semantic judgment to [Jev](https://typesafe.ai/) through [@mhingston5/jev-cli](https://github.com/mhingston/jev-cli).

It is inspired by [Ice-Hazymoon/jevlint](https://github.com/Ice-Hazymoon/jevlint), but intentionally uses jev-cli as the reusable provider and System One boundary instead of growing a second Jev client.

## What belongs here?

Use ordinary linters and static analysis whenever code can answer the question exactly.

Good jevcheck rules ask questions such as:

- Does this logging statement expose a sensitive value?
- Can this retry path continue without a meaningful bound?
- Does this handler leak an internal implementation detail to an external caller?

Poor rules ask questions such as:

- Is this import unused?
- Is this method longer than 50 lines?
- Does this file contain eval?
- How should this subsystem be redesigned?

The model does semantic judgment. Code owns everything deterministic.

## Capabilities

- reusable TypeScript API with injectable `SystemOneLikeClient`
- all providers supported by jev-cli
- Noul rules where YES always means violation
- file globs, exclusions, regex prefilters, negative `unless` filters, and bounded chunking
- ast-grep candidate selection with pattern, kind, or rule selectors
- JavaScript/TypeScript/TSX/HTML/CSS language inference with explicit override
- optional nearest-ancestor AST context while keeping the matched node as exact focus
- precise AST line/column metadata in Jev state, stylish output, and SARIF
- whole-file rules that skip rather than silently truncate oversized files
- answer caching keyed by rule, code, location, and provider/model namespace
- `shadow` and `owned` lifecycle semantics
- valid/invalid fixtures through `jevcheck test`
- exact staged-index and changed-file Git scopes
- accepted-backlog baselines and reasoned inline suppressions
- versioned, commit-able semantic replay corpora for offline evaluation
- strict offline replay with explicit coverage misses and no provider fallback
- versioned fixture calibration with thin-margin and fresh-run drift reporting
- deterministic mutation recall over real repository files
- stylish, JSON, and SARIF output
- rule/model/code fingerprints and stable finding fingerprints
- bundled agent skill, CI, and package metadata

Enforced graduation gates remain deliberately separate from the measurement features.

## Development

~~~sh
npm install
npm run typecheck
npm test
npm run build
npm run pack:check
~~~

After building:

~~~sh
node dist/cli.js --help
~~~

The package name is `@mhingston5/jevcheck` and the binary is `jevcheck`.

## Configuration

Create `jevcheck.config.json`:

~~~json
{
  "include": ["src/**/*.ts"],
  "exclude": ["**/*.test.ts"],
  "baselineFile": ".jevcheck/baseline.json",
  "replayFile": ".jevcheck/replay.json",
  "calibrationFile": ".jevcheck/calibration.json",
  "driftThreshold": 0.1,
  "rules": [
    {
      "id": "security/no-sensitive-log",
      "status": "shadow",
      "severity": "error",
      "why": "Logs must not expose credentials or other sensitive values.",
      "source": "docs/security.md#logging",
      "files": ["**/*.ts"],
      "ast": {
        "pattern": "console.$METHOD($ARG)",
        "context": {
          "ancestor": { "kind": "function_declaration" }
        }
      },
      "question": "Does this logging call expose a credential, token, API key, password, or other sensitive value?",
      "criteria": {
        "true": "A sensitive value itself can reach the logging call.",
        "false": "Only a field name, redacted placeholder, boolean, length, or non-sensitive identifier is logged."
      },
      "threshold": 0.8,
      "fixtures": {
        "valid": ["fixtures/no-sensitive-log/valid/**/*.ts"],
        "invalid": ["fixtures/no-sensitive-log/invalid/**/*.ts"]
      },
      "mutants": [
        {
          "id": "redacted-to-secret",
          "pattern": "/redacted/g",
          "replacement": "secret",
          "replaceAll": true
        }
      ]
    }
  ]
}
~~~

Rules default to `shadow`, `error`, and a 0.8 threshold. YES must always mean violation so probability interpretation and policy stay uniform.

### Candidate narrowing

Narrow deterministically before spending a model request:

- `files` chooses where a rule applies.
- `exclude` removes known irrelevant paths.
- `ast` uses in-process ast-grep to select exact nodes.
- `prefilter` is a cheap file-level gate before AST parsing and an additional filter over selected candidates.
- `unless` drops candidates with a deterministic exemption.
- `wholeFile` is for absence/global questions that genuinely require the complete file.

An AST match or prefilter is not evidence of a violation. It only selects the code Jev is allowed to judge.

An `ast` selector defines exactly one of:

~~~json
{ "pattern": "console.log($A)" }
{ "kind": "call_expression" }
{ "rule": { "all": [{ "kind": "call_expression" }, { "has": { "pattern": "$A" } }] } }
~~~

Language is inferred for `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `.tsx`, `.html`, `.htm`, and `.css`. Set `ast.language` explicitly to `javascript`, `typescript`, `tsx`, `html`, or `css` when inference is not appropriate.

The matched AST node remains the exact semantic focus. `ast.context.ancestor` can add the nearest matching ancestor as related context without widening the focus:

~~~json
{
  "ast": {
    "pattern": "await $CALL",
    "context": {
      "ancestor": { "kind": "function_declaration" }
    }
  }
}
~~~

`contextBefore` and `contextAfter` can override surrounding context independently. If omitted, the rule-level `contextLines` value is used, then the checker-wide default. Context stays bounded by `chunkChars`; an oversized focus is skipped rather than truncated.

AST findings carry precise 1-based line/column ranges and the matched AST kind. Those fields are sent to Jev as focus metadata and flow through JSON/SARIF output.

`ast` and `wholeFile` are mutually exclusive.

### Baselines and suppressions

Use a baseline for accepted existing backlog, not for hiding new findings:

~~~sh
jevcheck baseline
~~~

The default file is `.jevcheck/baseline.json`. It is intentionally commit-friendly; jevcheck's `.gitignore` ignores other `.jevcheck` state while allowing the baseline file.

A baseline fingerprint covers the rule, path, normalized focused source range, and deterministic occurrence identity. Unrelated edits outside the finding range do not invalidate it; changing the flagged code makes it report again.

For a specific intentional exception, put a comment on the finding or immediately above it and include a reason:

~~~ts
// jevcheck-ignore security/no-sensitive-log -- logger wrapper redacts this value
console.log(secret);
~~~

Markers without a reason are ignored. The marker name can be changed with `suppressionMarker`.

For broad chunk rules, suppressions and baselines apply to the chunk's focus range. Prefer AST selectors when you need precise finding ownership.

### Replay and offline evaluation

Replay is deliberately separate from the execution cache. The cache is an optimization; the replay corpus is durable evaluation evidence.

Capture the current semantic decisions with a live provider:

~~~sh
jevcheck record
jevcheck record --changed --base origin/main
~~~

By default this writes `.jevcheck/replay.json`. The file is versioned and commit-friendly, but it does **not** store source code or prompts verbatim. Each entry records hashed semantic inputs plus the rule/path/focus metadata, probability, and model that produced the decision.

Run the same semantic checks later without provider credentials or network access:

~~~sh
jevcheck replay
jevcheck replay --changed --base origin/main
~~~

Replay is strict. A request is reused only when the model-visible state and semantic question/criteria are identical. Policy-only changes such as `threshold`, `severity`, or `status` do not change the replay key, so you can evaluate those changes against the recorded probabilities. Changes to the question, criteria, candidate context, focused code, or other model-visible state produce an explicit replay miss.

Replay never falls back to the ordinary answer cache or a provider. Missing corpus coverage exits non-zero.

This is regression evidence, not ground truth. Replaying an old model decision proves that deterministic policy and candidate changes can be evaluated reproducibly; it does not prove that the original semantic judgment was correct.

### Fixture calibration and drift

Replay answers "can I reproduce the same semantic decisions without asking again?" Calibration answers a different question: "when I **do** ask again, have fixture probabilities moved?"

Record the current labelled fixture probabilities:

~~~sh
jevcheck test --record
~~~

The default file is `.jevcheck/calibration.json`. It is versioned, deterministic, and commit-friendly. Each fixture entry records rule, path, expected label, strongest probability, threshold, model label, and the exact semantic request hashes used for the fixture.

Recording bypasses the ordinary answer cache and only writes calibration when the fixture run is non-empty and passing.

Run a fresh comparison later:

~~~sh
jevcheck test --drift
~~~

Drift deliberately bypasses jevcheck's answer cache so every fixture is re-asked. It reports:

- mean absolute probability movement across comparable fixtures
- fixtures whose probability moved by at least the configured `driftThreshold` (default 0.10)
- **STALE** fixtures whose semantic request hashes or configured threshold changed
- newly added fixtures
- fixtures present in the recorded calibration but no longer in the current suite
- before/after model labels when available

Only fixtures with unchanged semantic request identities and threshold are compared for drift. If fixture code, the rule question/criteria, focus, model-visible context, or threshold changes, jevcheck reports the calibration as **STALE** rather than mixing a changed evaluation policy into the model-drift comparison.

A fixture that still passes but sits 0.05 or less from its rule threshold is marked `THIN`. Thin margins are warning evidence. Significant drift, stale calibration, added/removed fixtures, ordinary fixture failures, or diagnostics make `test --drift` exit non-zero.

Calibration is not accuracy proof. It detects movement relative to labelled examples; fixture quality and representativeness still matter.

### Rule evidence audit

`jevcheck rules audit` evaluates the evidence currently available for every rule without calling a provider:

~~~sh
jevcheck rules audit
jevcheck rules audit --format json
~~~

The audit recomputes current fixture semantic identities deterministically and compares them with committed calibration, so missing calibration, threshold changes, semantic-input changes, fixture failures, and thin margins are distinguishable.

Drift and mutation recall are represented explicitly, but jevcheck does not invent a "latest" value for process-local measurements. Until freshness-aware evidence persistence is added, the CLI reports those dimensions as missing rather than treating an old run as current. The exported `evaluateRuleEvidence` API accepts explicit drift and mutation evidence for callers that already hold current results.

Audit is advisory in this slice: it does not rewrite rule status and does not change normal check behavior.

### Mutation recall

Fixtures show that a rule can distinguish curated valid/invalid examples. Mutation recall asks a stronger question: does the rule catch a known violation when that violation is injected into **real repository code**?

Each rule can declare deterministic JSON-safe mutants:

~~~json
{
  "mutants": [
    {
      "id": "drop-limit",
      "pattern": "/\\.limit\\([^)]*\\)/g",
      "replacement": "",
      "replaceAll": true
    }
  ]
}
~~~

Run recall over the configured source set:

~~~sh
jevcheck recall
jevcheck recall --sample-size 20
jevcheck recall src/services/**/*.ts
~~~

For each mutant, jevcheck:

1. finds in-scope files where the mutation changes the text
2. orders candidates deterministically by rule, mutant, and path
3. samples up to 12 files by default
4. checks the original file first
5. excludes files that already violate the rule from the denominator
6. judges the mutated text with normal candidate/prefilter logic
7. counts a mutation as caught only when the mutated file crosses the rule threshold

If the mutant changes a file but the rule's deterministic candidate selection never asks Jev about it, that is a **recall miss**, not a skipped sample. This makes recall useful for detecting over-narrow prefilters and AST selectors as well as weak semantic questions.

Repository files are never modified; mutations exist only in memory. The command reports candidate count, sampled files, invalid originals, misses, per-mutant recall, and weakest measured recall. This slice measures recall but does not yet decide whether a rule is allowed to become `owned`.

Because configuration is JSON-only, this first mutation slice deliberately supports declarative regex replacement rather than arbitrary code callbacks. AST-specific mutation helpers can be added later if real rules show the regex boundary is too limiting.

## Commands

Check the configured include set:

~~~sh
jevcheck
~~~

Check only the exact staged index snapshot:

~~~sh
jevcheck --staged
~~~

Check working-tree changes and untracked files:

~~~sh
jevcheck --changed
~~~

Check a branch diff:

~~~sh
jevcheck --changed --base origin/main
~~~

Run labelled fixtures:

~~~sh
jevcheck test
~~~

Record fixture calibration or compare fresh drift:

~~~sh
jevcheck test --record
jevcheck test --drift
~~~

Record a reusable semantic decision corpus:

~~~sh
jevcheck record
~~~

Replay that corpus strictly offline:

~~~sh
jevcheck replay
~~~

Measure mutation recall against real code:

~~~sh
jevcheck recall
jevcheck recall --sample-size 20
~~~

Create or refresh accepted-backlog baseline entries:

~~~sh
jevcheck baseline
jevcheck baseline --changed --base origin/main
~~~

List configured rules without requiring provider credentials:

~~~sh
jevcheck list
~~~

Machine-readable output:

~~~sh
jevcheck --format json
jevcheck --changed --base origin/main --format sarif > jevcheck.sarif
~~~

SARIF contains only active findings. Suppressed findings remain available in JSON output for auditability. Shadow findings are emitted as SARIF notes; owned warnings as warnings; owned errors as errors.

Provider and model options are passed to jev-cli:

~~~sh
jevcheck --provider openrouter
jevcheck --provider cloudflare --model typesafe/jev
~~~

Credentials use the same environment variables as jev-cli.

## Rule lifecycle

`shadow` is the default. Findings are reported but never fail the check.

`owned` means the rule is intended to act as reviewer-of-record. An owned error finding exits with code 1. Owned warnings remain non-blocking.

This is intentionally conservative: a new probabilistic rule cannot accidentally become a merge gate just because it was added to configuration.

Fixture coverage, fresh probability calibration, thin-margin evidence, semantic-aware drift checks, and mutation recall now exist. A later slice should combine them into explicit evidence gates before `owned` status is accepted.

## Exit codes

- 0: no blocking findings
- 1: at least one owned error finding, or a failed fixture test
- 2: configuration/runtime/provider error

`jevcheck baseline` records the current active findings and does not fail because those findings exist.

## Programmatic API

~~~ts
import { createJevClient } from "@mhingston5/jev-cli";
import { createJevCheck, MemoryAnswerCache } from "@mhingston5/jevcheck";

const checker = createJevCheck({
  client: createJevClient({ provider: "typesafe" }),
  cache: new MemoryAnswerCache(),
  rules: [
    {
      id: "reliability/unbounded-retry",
      status: "shadow",
      files: ["src/**/*.ts"],
      ast: {
        pattern: "while ($COND) { $$$BODY }",
        context: { ancestor: { kind: "function_declaration" } }
      },
      question: "Can this retry loop continue without a meaningful bound?"
    }
  ]
});

const result = await checker.checkSource(
  "src/client.ts",
  "while (true) { await retry(); }"
);
~~~

Every evaluation records the rule fingerprint, candidate code fingerprint, returned model, probability, threshold, and whether the answer came from cache or replay. Every reported finding also has a stable focused-range fingerprint used by baselines and SARIF.

For programmatic replay, pass a `SemanticDecisionStore` to `createJevCheck`. `MemorySemanticDecisionStore` is useful in tests; `DiskSemanticDecisionStore` writes the versioned corpus. Call `flush()` after a recording run when using the disk store. Set `replayOnly: true` to make the checker strict and provider-free.

## Architecture

~~~text
@mhingston5/jev-cli
 provider selection + System One transport + typed answers
            |
            v
         jevcheck
 deterministic selection + semantic judgment + policy
       |            |             |
       v            v             v
    ast-grep     baseline       reporters
       \            |             /
        +-------- engine --------+
                  |
            CLI / library API
~~~

Provider choice changes transport, not lint semantics. Domain policy stays in jevcheck.

## Next slices

The remaining useful slices are:

1. enforced shadow-to-owned graduation gates reusing the rule evidence evaluator
2. related-node AST context across separate definitions/callers
3. optional AST-specific mutation helpers, only if declarative regex mutants prove insufficient

Generated code fixes remain intentionally out of scope. Findings should feed a coding agent or deterministic refactoring tool rather than letting the semantic judge edit code itself.

## License

MIT
