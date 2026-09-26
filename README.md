# jevcheck

Semantic linting for code-review questions ordinary linters cannot answer.

`jevcheck` lets you turn bounded review concerns such as "does this log expose a secret?" or "can this retry loop run without a meaningful bound?" into repeatable lint rules.

The core rule is simple:

> **Use deterministic code for selection, validation, thresholds, policy, and lifecycle. Use Jev only for bounded semantic judgement where YES consistently means "violation present".**

`jevcheck` is built on [`@mhingston5/jev-cli`](https://github.com/mhingston/jev-cli), so provider selection and Jev transport stay outside the linter itself.

## Quick start

### 1. Install

Node.js 20 or newer is required.

~~~sh
npm install --save-dev @mhingston5/jevcheck
~~~

The package installs the `jevcheck` binary. The examples below use `npx` so a project-local install works without any global setup.

### 2. Configure a Jev provider

TypeSafe is the default provider:

~~~sh
export TYPESAFE_API_KEY="..."
~~~

You can also use any provider supported by [`@mhingston5/jev-cli`](https://github.com/mhingston/jev-cli#providers), for example:

~~~sh
export OPENROUTER_API_KEY="..."
export JEV_PROVIDER="openrouter"
~~~

Or select the provider per run:

~~~sh
npx jevcheck --provider openrouter
~~~

Credentials are read from environment variables. Do not put API keys in `jevcheck.config.json`.

### 3. Add your first rule

Create `jevcheck.config.json` in the repository root:

~~~json
{
  "include": ["src/**/*.ts"],
  "exclude": ["**/*.test.ts"],
  "rules": [
    {
      "id": "security/no-sensitive-log",
      "status": "shadow",
      "severity": "error",
      "files": ["**/*.ts"],
      "ast": {
        "pattern": "console.$METHOD($ARG)"
      },
      "question": "Does this logging call expose a credential, token, API key, password, or other sensitive value?",
      "criteria": {
        "true": "A sensitive value itself can reach the logging call.",
        "false": "Only a field name, redacted placeholder, boolean, length, or non-sensitive identifier is logged."
      }
    }
  ]
}
~~~

New rules should normally start as `shadow`. Shadow findings are visible but non-blocking, which gives you room to inspect false positives and refine the rule before it can fail CI.

Rules default to:

- `status: "shadow"`
- `severity: "error"`
- `threshold: 0.8`

### 4. Run it

Check the configured source set:

~~~sh
npx jevcheck
~~~

For day-to-day development, smaller scopes are usually better:

~~~sh
# exact staged index snapshot
npx jevcheck --staged

# working-tree changes and untracked files
npx jevcheck --changed

# branch diff
npx jevcheck --changed --base origin/main
~~~

If the rule finds something in `shadow` mode, you get the finding without failing the check.

That is enough to start using `jevcheck`.

## What should become a jevcheck rule?

Use ordinary static analysis whenever code can answer the question exactly.

Good semantic rules ask one bounded question about meaning or intent:

- Does this logging statement expose a sensitive value?
- Can this retry path continue without a meaningful bound?
- Does this handler leak an internal implementation detail to an external caller?
- Does this error message reveal information that should stay internal?

Keep deterministic questions out of Jev:

- Is this import unused?
- Is this method longer than 50 lines?
- Does this file contain `eval`?
- Is this dependency forbidden?
- Does this AST node have a particular shape?

And avoid open-ended review prompts such as:

- How should this subsystem be redesigned?
- Is this good code?
- What would you improve here?

A good rule has a clear semantic boundary, a narrow candidate set, and a YES answer that always means the same thing: **a violation is present**.

## How it works

A `jevcheck` rule has three layers:

~~~text
deterministic candidate selection
            |
            v
   bounded Jev judgement
            |
            v
deterministic threshold + policy
~~~

That separation is deliberate.

`jevcheck` owns deterministic behaviour such as:

- file selection and exclusions
- AST matching
- regex prefilters and exemptions
- chunking and context limits
- thresholds
- baselines and suppressions
- caching and replay
- rule lifecycle
- exit codes and CI policy

Jev answers the bounded semantic question for the selected code.

An AST match or regex hit is therefore **not** evidence of a violation. It only decides what Jev is allowed to judge.

## Choosing candidates

Narrow candidates as much as you can before making a semantic request.

### AST selectors

Prefer AST selection when the construct can be identified structurally.

Each `ast` selector defines exactly one of:

~~~json
{ "pattern": "console.log($A)" }
~~~

~~~json
{ "kind": "call_expression" }
~~~

~~~json
{
  "rule": {
    "all": [
      { "kind": "call_expression" },
      { "has": { "pattern": "$A" } }
    ]
  }
}
~~~

Language is inferred for JavaScript, TypeScript, TSX, HTML, and CSS. You can override it with `ast.language` when needed.

The matched AST node remains the exact semantic focus. If the model needs nearby structural context, add the nearest matching ancestor:

~~~json
{
  "ast": {
    "pattern": "await $CALL",
    "context": {
      "ancestor": {
        "kind": "function_declaration"
      }
    }
  }
}
~~~

### Prefilters and exemptions

For non-AST rules:

- `files` chooses where the rule applies.
- `exclude` removes known irrelevant paths.
- `prefilter` cheaply rejects files/candidates before semantic evaluation.
- `unless` removes candidates with a deterministic exemption.
- `wholeFile` is available for genuinely global or absence-style questions.

`ast` and `wholeFile` are mutually exclusive.

Keep semantic context bounded. Oversized focuses are skipped rather than silently truncated.

### Context sufficiency and privacy

A candidate should contain enough deterministically selected evidence for the bounded question to be answered defensibly. If the answer depends on information that is not present, improve the selector or bounded context, split the rule, or decide that the concern is not suitable for that scope. Do not add a second model judgement that asks whether the first judgement is applicable.

Keep model-visible context to the smallest useful set. Depending on the configured provider, focused source code and surrounding context can leave the local machine. Do not deliberately include secrets, credentials, private keys, environment files, generated output, vendored code, or unrelated proprietary content.

Context is evidence, not permission to broaden the question. Nearby code may help interpret the exact focus, but must not become an independent reason to report a violation.

## A practical rule lifecycle

A useful default workflow is:

~~~text
author -> shadow -> fixtures -> calibrate -> drift/recall/robustness -> audit -> owned
~~~

You do not need all of this to experiment with a shadow rule. The evidence workflow matters when you want a semantic rule to become a blocking reviewer.

### 1. Start in shadow

~~~json
{
  "id": "reliability/unbounded-retry",
  "status": "shadow",
  "question": "Can this retry path continue without a meaningful bound?"
}
~~~

Run it against real changes and inspect where it is right or wrong.

### 2. Add labelled fixtures

~~~json
{
  "fixtures": {
    "valid": ["fixtures/unbounded-retry/valid/**/*.ts"],
    "invalid": ["fixtures/unbounded-retry/invalid/**/*.ts"]
  }
}
~~~

Then run:

~~~sh
npx jevcheck test
~~~

Fixtures answer a basic question: can the rule distinguish examples you believe are valid and invalid?

### 3. Record calibration

When the fixtures pass:

~~~sh
npx jevcheck test --record
~~~

This records the current fixture probabilities in `.jevcheck/calibration.json`.

Later, re-ask those fixtures and compare the probabilities:

~~~sh
npx jevcheck test --drift
~~~

Drift checks intentionally bypass the normal answer cache.

### 4. Measure mutation recall

Fixtures are curated. Mutation recall checks whether the rule still catches known violations inserted into real repository code.

Add deterministic mutants to the rule:

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

Then run:

~~~sh
npx jevcheck recall
~~~

Repository files are never modified; mutations exist only in memory.

### 5. Probe semantic robustness

Fixtures and mutation recall test whether a rule catches the right semantic changes. Robustness probes the opposite failure mode: whether model-visible text that should be irrelevant can change the judgement.

~~~sh
npx jevcheck test --robustness
~~~

The command keeps the selected source and semantic focus unchanged, then re-runs the same judgement with deterministic untrusted surrounding context under three conditions:

- a direct instruction to ignore the rule
- a false claim that the code was already approved
- unrelated nearby context

It reports probability movement and classification flips, and records freshness-aware results in `.jevcheck/evidence.json` only when every expected fixture/perturbation case was measured. Incomplete runs surface diagnostics and do not overwrite durable evidence. Robustness is intentionally advisory for now: flips appear as audit warnings rather than silently changing graduation policy.

### 6. Audit the evidence

~~~sh
npx jevcheck rules audit
~~~

The audit reports whether each rule has the evidence required to act as an owned rule and explains any blockers. It also shows advisory threshold-separation diagnostics from current labelled calibration and persisted robustness results. If valid and invalid fixture probabilities overlap, the audit says explicitly that no single threshold can separate the labelled fixtures rather than encouraging threshold tuning.

### 7. Promote to owned

Only after the rule has earned that responsibility:

~~~json
{
  "status": "owned"
}
~~~

An owned `error` finding is blocking. An owned `warning` remains non-blocking.

Normal checks and replay fail closed if an owned rule's required evidence is missing, stale, or failing. `jevcheck` never silently downgrades it back to shadow.

### Stop when the rule is good enough

The evidence lifecycle exists to establish that a bounded rule is useful and stable, not to maximize a model probability or benchmark score.

Once the semantic boundary is clear, labelled evidence separates valid from invalid cases, drift/recall/robustness are acceptable, and the rule has enough context to make the intended judgement, stop tuning it. Do not broaden the question, enlarge model-visible context, weaken graduation policy, or move the threshold merely to improve measured results.

If a rule only works after those kinds of changes, prefer narrowing or splitting the rule, improving deterministic candidate selection, or leaving the concern outside `jevcheck`.

## Baselines and intentional exceptions

### Baseline existing backlog

If you want to adopt a rule without failing on already-accepted findings:

~~~sh
npx jevcheck baseline
~~~

The default file is `.jevcheck/baseline.json`.

A baseline is for accepted existing backlog. New or changed violations still report.

### Suppress one intentional exception

Put a reasoned suppression on the finding or immediately above it:

~~~ts
// jevcheck-ignore security/no-sensitive-log -- logger wrapper redacts this value
console.log(secret);
~~~

Suppressions without a reason are ignored.

Use a baseline for repository backlog and an inline suppression for a specific durable exception.

## Replay semantic decisions offline

The normal answer cache is an optimization. Replay is durable evaluation evidence.

Record semantic decisions from a live provider:

~~~sh
npx jevcheck record
~~~

Or only for a branch diff:

~~~sh
npx jevcheck record --changed --base origin/main
~~~

This writes `.jevcheck/replay.json` by default.

Re-run those exact semantic decisions later without provider credentials or network access:

~~~sh
npx jevcheck replay
~~~

Replay is strict:

- matching semantic requests are reused
- policy-only changes such as threshold, severity, or status can be evaluated against the recorded probability
- changes to the question, criteria, focused code, or model-visible context produce a replay miss
- replay never falls back to a live provider

Replay gives reproducibility, not ground truth. A recorded judgement can still have been wrong.

## Files worth committing

The default `.gitignore` policy keeps transient cache state out while allowing durable evidence files to be committed.

| File | Purpose | Commit? |
| --- | --- | --- |
| `jevcheck.config.json` | Rules and checker configuration | Yes |
| `.jevcheck/baseline.json` | Accepted existing findings | Usually |
| `.jevcheck/replay.json` | Reusable semantic decisions | When replay is part of your workflow |
| `.jevcheck/calibration.json` | Recorded fixture probabilities | For evidence-gated rules |
| `.jevcheck/evidence.json` | Drift, mutation, and robustness evidence | For evidence-gated rules |
| `.jevcheck/cache.json` | Local answer cache | No |

These evidence files contain hashes and evaluation metadata rather than a second copy of your source code or prompts.

## Common commands

| Command | Use it for |
| --- | --- |
| `jevcheck` | Check the configured source set |
| `jevcheck --staged` | Check the exact Git index snapshot |
| `jevcheck --changed` | Check working-tree changes and untracked files |
| `jevcheck --changed --base origin/main` | Check a branch diff |
| `jevcheck test` | Run labelled fixtures |
| `jevcheck test --record` | Record fixture calibration |
| `jevcheck test --drift` | Re-ask fixtures and detect probability drift |
| `jevcheck test --robustness` | Probe fixture stability under label-preserving adversarial context |
| `jevcheck recall` | Measure mutation recall against real code |
| `jevcheck rules audit` | Inspect rule evidence without calling a provider |
| `jevcheck baseline` | Create or refresh accepted-backlog entries |
| `jevcheck record` | Record semantic decisions for replay |
| `jevcheck replay` | Re-run the recorded decisions strictly offline |
| `jevcheck list` | List configured rules without provider credentials |

Use `--format json` for machine-readable output.

For code-scanning integrations:

~~~sh
npx jevcheck --changed --base origin/main --format sarif > jevcheck.sarif
~~~

SARIF contains active findings only. Shadow findings are emitted as notes, owned warnings as warnings, and owned errors as errors.

## Provider configuration

Provider and model selection are inherited from `@mhingston5/jev-cli`.

| Provider | `--provider` / `JEV_PROVIDER` | Credentials |
| --- | --- | --- |
| TypeSafe | `typesafe` | `TYPESAFE_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `vercel` | `AI_GATEWAY_API_KEY` |
| Cloudflare AI | `cloudflare` | `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` |
| Custom | `custom` | `JEV_API_KEY` when required |

Override the model with `--model` or `JEV_MODEL`.

See [jev-cli provider documentation](https://github.com/mhingston/jev-cli#providers) for provider-specific details.

## Configuration example

A more complete rule can include provenance, AST context, fixtures, and mutants:

~~~json
{
  "include": ["src/**/*.ts"],
  "exclude": ["**/*.test.ts"],
  "baselineFile": ".jevcheck/baseline.json",
  "replayFile": ".jevcheck/replay.json",
  "calibrationFile": ".jevcheck/calibration.json",
  "evidenceFile": ".jevcheck/evidence.json",
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
          "ancestor": {
            "kind": "function_declaration"
          }
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

## Evidence and owned-rule graduation

The default graduation policy requires:

- at least one valid and invalid fixture
- current passing calibration
- no thin fixture margins
- clean current drift evidence
- configured and measured mutants
- minimum mutation recall of 0.90
- no zero-judged mutants
- rule `source` provenance

You can override the small global policy surface when there is a deliberate reason:

~~~json
{
  "graduation": {
    "minMutationRecall": 0.95,
    "allowThinMargins": false,
    "requireSource": true
  }
}
~~~

A typical graduation sequence is:

~~~sh
npx jevcheck test --record
npx jevcheck test --drift
npx jevcheck recall
npx jevcheck test --robustness
npx jevcheck rules audit

# after the audit is ready:
# change status from "shadow" to "owned"

npx jevcheck
~~~

Changing only `status` does not stale semantic evidence. Changes to the semantic request, threshold, candidate semantics, relevant mutation inputs, calibration, or provider/model identity can.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No blocking findings |
| `1` | Blocking finding or failed measurement/test command |
| `2` | Configuration, runtime, or provider error |

For normal checks, only owned error findings are blocking.

## Programmatic API

`jevcheck` can also be embedded as a TypeScript library:

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
        context: {
          ancestor: {
            kind: "function_declaration"
          }
        }
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

Every evaluation records rule/code fingerprints, model, probability, threshold, and cache/replay provenance. Findings also carry stable focused-range fingerprints used by baselines and SARIF.

For programmatic replay, pass a `SemanticDecisionStore` as `decisionStore`. `DiskSemanticDecisionStore` persists the versioned replay corpus, while `MemorySemanticDecisionStore` is useful for tests. After a recording run, call `await decisionStore.flush?.()` when using a persistent store. To replay without a provider, construct the checker with that store, omit `client`, and set `replayOnly: true`; missing decisions then fail instead of falling back to a live provider.

## Architecture

~~~text
@mhingston5/jev-cli
 provider selection + System One transport + typed answers
            |
            v
         jevcheck
 deterministic selection + semantic judgement + policy
       |            |             |
       v            v             v
    ast-grep     evidence       reporters
       \            |             /
        +-------- engine --------+
                  |
            CLI / library API
~~~

Generated fixes are intentionally out of scope. `jevcheck` reports bounded semantic findings; a coding agent or deterministic refactoring tool can decide what to change.

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

## Agent skill

The npm package includes `skills/jevcheck/SKILL.md` for coding agents working with `jevcheck` rules, evidence, suppressions, replay, and graduation.

## License

MIT
