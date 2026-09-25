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
- ast-grep candidate selection for exact TypeScript/TSX constructs
- whole-file rules that skip rather than silently truncate oversized files
- answer caching keyed by rule, code, location, and provider/model namespace
- `shadow` and `owned` lifecycle semantics
- valid/invalid fixtures through `jevcheck test`
- exact staged-index and changed-file Git scopes
- accepted-backlog baselines and reasoned inline suppressions
- stylish, JSON, and SARIF output
- rule/model/code fingerprints and stable finding fingerprints
- bundled agent skill, CI, and package metadata

Replay/offline evaluation, calibration/drift, mutation recall, and enforced graduation gates remain deliberately separate follow-up slices.

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
  "rules": [
    {
      "id": "security/no-sensitive-log",
      "status": "shadow",
      "severity": "error",
      "why": "Logs must not expose credentials or other sensitive values.",
      "source": "docs/security.md#logging",
      "files": ["**/*.ts"],
      "ast": {
        "language": "typescript",
        "rule": {
          "pattern": "console.$METHOD($ARG)"
        },
        "contextBefore": 3,
        "contextAfter": 3
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
      }
    }
  ]
}
~~~

Rules default to `shadow`, `error`, and a 0.8 threshold. YES must always mean violation so probability interpretation and policy stay uniform.

### Candidate narrowing

Narrow deterministically before spending a model request:

- `files` chooses where a rule applies.
- `exclude` removes known irrelevant paths.
- `ast` uses an in-process ast-grep rule to select exact TypeScript/TSX nodes.
- `prefilter` narrows regex candidates; with `ast`, it becomes an additional cheap filter over each selected candidate.
- `unless` drops candidates with a deterministic exemption.
- `wholeFile` is for absence/global questions that genuinely require the complete file.

An AST match or prefilter is not evidence of a violation. It only selects the code Jev is allowed to judge.

AST candidates carry an exact focus line range plus optional bounded surrounding context. `ast` and `wholeFile` are mutually exclusive. Oversized AST nodes and whole-file candidates are skipped with a diagnostic rather than silently truncated.

### Baselines and suppressions

Use a baseline for accepted existing backlog, not for hiding new findings:

~~~sh
jevcheck baseline
~~~

The default file is `.jevcheck/baseline.json`. It is intentionally commit-friendly; jevcheck's `.gitignore` ignores other `.jevcheck` state while allowing the baseline file.

A baseline fingerprint covers the rule, path, and normalized focused source range. Unrelated edits outside the finding range do not invalidate it; changing the flagged code makes it report again.

For a specific intentional exception, put a comment on the finding or immediately above it and include a reason:

~~~ts
// jevcheck-ignore security/no-sensitive-log -- logger wrapper redacts this value
console.log(secret);
~~~

Markers without a reason are ignored. The marker name can be changed with `suppressionMarker`.

For broad chunk rules, suppressions and baselines apply to the chunk's focus range. Prefer AST selectors when you need precise finding ownership.

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

Fixture coverage exists now. A later slice should make graduation stricter by enforcing labelled precision/recall, calibration margin, mutation recall, and drift requirements before `owned` status is accepted.

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
        language: "typescript",
        rule: { pattern: "while ($COND) { $$$BODY }" },
        contextBefore: 3,
        contextAfter: 3
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

Every evaluation records the rule fingerprint, candidate code fingerprint, returned model, probability, threshold, and whether the answer came from cache. Every reported finding also has a stable focused-range fingerprint used by baselines and SARIF.

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

The next useful reliability slice is replay/offline evaluation so rule changes can be tested without repeatedly calling a provider. After that:

1. related-node AST context for cases where the evidence lives in another definition/caller
2. recorded fixture probabilities and drift checks
3. mutation recall
4. enforced shadow-to-owned graduation gates
5. a `rules audit` command exposing evidence and blockers

Generated code fixes remain intentionally out of scope. Findings should feed a coding agent or deterministic refactoring tool rather than letting the semantic judge edit code itself.

## License

MIT
