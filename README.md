# jevcheck

Semantic linting for code-review questions a syntax-based linter cannot answer.

jevcheck keeps candidate selection, thresholds, caching, CI policy, and rule lifecycle deterministic, then delegates one bounded semantic judgment to [Jev](https://typesafe.ai/) through [@mhingston5/jev-cli](https://github.com/mhingston/jev-cli).

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

## First slice

The initial implementation includes:

- a reusable TypeScript API with injectable SystemOneLikeClient
- all providers supported by jev-cli
- Noul rules where YES always means violation
- file globs, exclusions, regex prefilters, negative unless filters, and bounded chunking
- whole-file rules that skip rather than silently truncate oversized files
- answer caching keyed by rule, code, location, and provider/model namespace
- shadow and owned lifecycle semantics
- valid/invalid fixtures through jevcheck test
- changed/staged Git scopes
- stylish and JSON output
- rule/model/code fingerprints in evaluations
- a bundled agent skill
- CI and package metadata

AST-aware candidates, baselines, SARIF, drift recording, mutation recall, and enforced graduation gates are deliberately deferred.

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

The intended package name is @mhingston5/jevcheck and the binary is jevcheck.

## Configuration

Create jevcheck.config.json:

~~~json
{
  "include": ["src/**/*.ts"],
  "exclude": ["**/*.test.ts"],
  "rules": [
    {
      "id": "security/no-sensitive-log",
      "status": "shadow",
      "severity": "error",
      "why": "Logs must not expose credentials or other sensitive values.",
      "source": "docs/security.md#logging",
      "files": ["**/*.ts"],
      "prefilter": "console\\.(log|info|debug)",
      "contextLines": 20,
      "question": "Does this code log a credential, token, API key, password, or other sensitive value?",
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

Rules default to shadow, error, and a 0.8 threshold. YES must always mean violation so probability interpretation and policy stay uniform.

### Candidate narrowing

Narrow deterministically before spending a model request:

- files chooses where a rule applies.
- exclude removes known irrelevant paths.
- prefilter finds candidate locations and sends only a bounded context window around them.
- unless drops candidates with a deterministic exemption.
- wholeFile is for absence/global questions that genuinely require the complete file.

A prefilter is not evidence of a violation. It only selects the code Jev is allowed to judge.

Oversized whole-file candidates are skipped with a diagnostic. jevcheck never silently sends a partial file while pretending it saw the whole thing.

## Commands

Check the configured include set:

~~~sh
jevcheck
~~~

Check only staged files:

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

List configured rules without requiring provider credentials:

~~~sh
jevcheck list
~~~

Machine-readable output:

~~~sh
jevcheck --format json
~~~

Provider and model options are passed to jev-cli:

~~~sh
jevcheck --provider openrouter
jevcheck --provider cloudflare --model typesafe/jev
~~~

Credentials use the same environment variables as jev-cli.

## Rule lifecycle

shadow is the default. Findings are reported but never fail the check.

owned means the rule is intended to act as reviewer-of-record. An owned error finding exits with code 1. Owned warnings remain non-blocking.

This is intentionally conservative: a new probabilistic rule cannot accidentally become a merge gate just because it was added to configuration.

Fixture coverage exists now. A later slice should make graduation stricter by enforcing labelled precision/recall, calibration margin, mutation recall, and drift requirements before owned status is accepted.

## Exit codes

- 0: no blocking findings
- 1: at least one owned error finding, or a failed fixture test
- 2: configuration/runtime/provider error

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
      prefilter: "retry|while|for",
      question: "Can this retry path continue without a meaningful bound?"
    }
  ]
});

const result = await checker.checkSource(
  "src/client.ts",
  "while (true) { await retry(); }"
);
~~~

Every evaluation records the rule fingerprint, candidate code fingerprint, returned model, probability, threshold, and whether the answer came from cache.

## Architecture

~~~text
@mhingston5/jev-cli
 provider selection + System One transport + typed answers
            |
            v
         jevcheck
 rules + candidate selection + chunking + cache + policy
       |                         |
       v                         v
      CLI                    library API
~~~

Provider choice changes transport, not lint semantics. Domain policy stays in jevcheck.

## Next slices

The next useful slice is AST-aware candidate extraction plus CI integration:

1. ast-grep adapter with node-exact ranges and related-node context
2. baselines and reasoned inline suppressions
3. SARIF for GitHub code scanning
4. replay/offline evaluation support

After that, make rule quality measurable:

1. recorded fixture probabilities and drift checks
2. mutation recall
3. enforced shadow-to-owned graduation gates
4. a rule audit command exposing evidence and blockers

Generated code fixes are intentionally out of scope. Findings can carry deterministic remediation guidance later, but edits belong to a coding agent or refactoring tool.

## License

MIT
