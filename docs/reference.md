# CLI, configuration and developer reference

For first use see [README](../README.md) and [the executable example](../examples/queue-ack/README.md). For `projectWhen.hasDependency` schema, supported .NET/Go/Node manifests, and root/workspace behavior, see [declared dependency predicates](concepts.md#declared-dependency-predicates).
## Common commands

| Command | Use it for |
| --- | --- |
| `jevcheck` | Check the configured source set |
| `jevcheck --staged` | Check the exact Git index snapshot |
| `jevcheck --changed` | Check working-tree changes and untracked files |
| `jevcheck --changed --base origin/main` | Check a branch diff |
| `jevcheck test` | Run labelled fixtures |
| `jevcheck test --record` | Record fixture calibration |
| `jevcheck test --drift` | Re-ask development fixtures and detect probability drift |
| `jevcheck test --confirm` | Evaluate and record untouched confirmation fixtures |
| `jevcheck test --robustness` | Probe fixture stability under label-preserving adversarial context |
| `jevcheck recall` | Measure mutation recall against real code |
| `jevcheck rules audit` | Inspect rule evidence, applicability, and coverage without calling a provider |
| `jevcheck coverage record [--attest-reviewed]` | Fingerprint sources; optionally assert human review |
| `jevcheck coverage verify --check <id> -- <command> [args...]` | Run a named check in GitHub Actions and save its exit status for this job/revision |
| `jevcheck baseline` | Create or refresh accepted-backlog entries |
| `jevcheck record` | Record semantic decisions for replay |
| `jevcheck replay` | Re-run the recorded decisions strictly offline |
| `jevcheck list` | List configured rules without provider credentials |
| `jevcheck inspect` | Preview exact semantic requests without a provider call |

Use `--format json` for backward-compatible machine-readable output. Existing objects and raw arrays remain intact; the additional `state` and `diagnostics` fields in rule audits are additive.

### Human output and agent JSON

Default `stylish` output is summary-first for `check`, `rules audit`, and `inspect`. Findings are grouped by file and rule. Audits show states, blockers and next actions first, with all evidence checks available via `rules audit --verbose`. `inspect` hides the full request bodies and semantic keys by default; `inspect --verbose` shows exact bounded requests without executing them.

The existing `--format json` retains each command's original top-level structure (including raw arrays for `list` and `rules audit`), and is extended with optional machine-readable evidence diagnostics. The opt-in `--format json-v2` uses a consistent envelope for agent integrations:

~~~sh
jevcheck rules audit --format json-v2
jevcheck inspect src/handler.ts --format json-v2
jevcheck --changed --format json-v2
jevcheck coverage verify --check unit --format json-v2 -- npm test
~~~

~~~json
{
  "schemaVersion": 2,
  "command": "rules-audit",
  "outcome": "block",
  "summary": {"rules": 1, "blocked": 1, "warnings": 0, "ready": 0, "inapplicable": 0, "reviewedOnly": 0, "ciVerified": 0, "semanticFallback": 0},
  "diagnostics": [{"code": "EVIDENCE_FIXTURES", "level": "error", "message": "no invalid fixtures", "ruleId": "example", "remediation": "Add or fix valid and invalid fixtures.", "suggestedCommand": "jevcheck test"}],
  "data": [{"ruleId": "example", "currentStatus": "shadow", "checks": [], "blockers": ["no invalid fixtures"], "warnings": [], "readyForOwned": false, "execution": "semantic", "state": "blocked", "outcome": "block", "diagnostics": []}]
}
~~~

The example is illustrative; the `data` field contains the **complete per-command result**, including evidence checks and bounded inspection requests. An error after requesting JSON returns a single value with `outcome: "error"`, structured `error` and `diagnostics` plus exit code 2; `json-v2` also includes `data: null`. Diagnostic codes are stable identifiers, with optional `path`, `ruleId`, `remediation` and `suggestedCommand`. Child stdout is routed to stderr for `coverage verify` in both JSON modes. Put `--format` *before* `--`; flags after `--` belong to the child.

### JSON command payloads and outcomes

| Command | `data` in `json-v2` (top-level value in legacy `json`) | Outcome semantics |
| --- | --- | --- |
| `check` / `replay` | `{ findings[], suppressedFindings[], evaluations[], diagnostics[], stats }` | `block` for blocking owned findings, error diagnostics, or replay misses; `warn` for advisory findings |
| `rules audit` | `[{ruleId,currentStatus,execution,checks[],blockers[],warnings[],readyForOwned,state,outcome,diagnostics[]},...]` | `block` for evidence blockers; this does **not** change the audit's exit code (0) |
| `inspect` | `{ rules[], inspections[], diagnostics[] }` with request payloads retained | `block` for error diagnostics, `warn` for warnings; no provider call |
| `coverage verify` | `{checkId,status,evidenceFile}` | `block` when the named CI check fails; subprocess exit status is propagated |
| CLI/config/runtime error | A single `{command,outcome,summary,diagnostics[],error}` in legacy mode, or the versioned envelope with `data:null` | `error`, exit code 2 |

Other supported commands (`list`, `test`, `recall`, `record`, `baseline`, `coverage record`) preserve their detailed legacy payloads under `data`; fixture failures and incomplete robustness gates also surface blocking outcomes in `json-v2`. Individual diagnostics are additive to existing normal results rather than a replacement for their detailed evidence.

The audit `state` distinguishes `semantic`, `blocked`, `semantic-fallback`, `inapplicable`, `reviewed-only`, and `ci-verified`. Human-reviewed coverage does **not** prove CI execution; inapplicable rules are **not** evidence-ready. Audits can return `outcome: "block"` while exiting 0: this is a graduation-readiness signal rather than a failed command. Check/inspect/fixture failures exit 1; `coverage verify` propagates the command's positive failure code; argument/config/runtime errors exit 2. SARIF output is unchanged.


For code-scanning integrations:

~~~sh
npx jevcheck --changed --base origin/main --format sarif > jevcheck.sarif
~~~

SARIF contains active findings only. Shadow findings are emitted as notes, owned warnings as warnings, and owned errors as errors.

## Git snapshot semantics

A check resolves **source and all associated policy inputs together**, rather than mixing the index with the working tree. Run these commands from within a Git repository. The Git snapshot modes are read-only inputs; temporary checkouts are removed afterwards.

| Mode | Selected source paths | Source content | Rules, project conditions, ADRs, fixtures, calibration and coverage evidence |
| --- | --- | --- | --- |
| Default (no Git flag) | Configured working-tree files | Working tree | Working tree |
| `--changed` | Tracked changes against HEAD (staged **or** unstaged), plus untracked non-ignored files | Working tree | Working tree |
| `--staged` | Added/modified/type-changed destinations in the Git index relative to HEAD | **Index** | **Index** |
| `--changed --base <ref>` | Added/modified/type-changed destinations in `<ref>...HEAD` (merge-base diff) | **HEAD commit** | **HEAD commit** |

- Deletions are not evaluated as source files. Renames are treated as deletion + addition, so only the destination is checked. Partially staged files use exactly the staged blob under `--staged`.
- The index/HEAD snapshot includes only Git-tracked files in that revision. Unstaged, untracked, and ignored policy files **cannot silently affect** a snapshot run. A required config missing from the revision is an error; unavailable evidence fails the normal ownership/coverage gates rather than borrowing working-tree data.
- `--config` and configured local evidence/ADR paths must stay repository-relative for snapshot runs, so an absolute external file cannot change policy results. External HTTP(S) rule sources remain externally referenced, not fingerprinted by Git.
- `--staged` and `--changed --base` support `check`, `inspect`, `replay`, and `list`. Commands that write calibration, baselines, replay corpora, or evidence must run against the working tree instead. Cache writes from snapshot runs are temporary and not persisted in the working tree.
- To check the **working-tree version** of a branch's changed files, use `--changed` without `--base` (which also considers other local/untracked changes). To inspect exactly what a branch PR will change in CI, use `--changed --base <ref>` after fetching that base ref.
## Provider configuration

Provider and model selection are inherited from `@mhingston5/jev-cli`.

| Provider | `--provider` / `JEV_PROVIDER` | Credentials |
| --- | --- | --- |
| TypeSafe | `typesafe` | `TYPESAFE_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `vercel` | `AI_GATEWAY_API_KEY` |
| Cloudflare AI | `cloudflare` | `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` |
| Custom/System One-compatible | `custom` | `JEV_API_KEY` when required |

For a custom System One-compatible API, set `JEV_ENDPOINT` to the endpoint (for example an implementation of the `/v1/systemone` contract). A custom provider has no implicit model default; set `--model` or `JEV_MODEL` only when the endpoint requires one.

Override the model with `--model` or `JEV_MODEL`.

See [jev-cli provider documentation](https://github.com/mhingston/jev-cli#providers) for provider-specific details.

## Configuration example

Start with a bounded, non-blocking rule in `jevcheck.config.json`:

~~~json
{
  "include": ["src/**/*.ts"],
  "rules": [
    {
      "id": "reliability/queue-ack",
      "ast": "function_declaration",
      "contains": "queue.publish(",
      "question": "Can this handler return success if queue publication fails without recovery?"
    }
  ]
}
~~~

- `include` limits scanned files; per-rule `files` narrows the scope only when needed.
- `ast: "function_declaration"` is equivalent to `ast: { "kind": "function_declaration" }`. A string means an AST **kind**, not an AST pattern; use the object form for `pattern`, `rule`, `language` and context options.
- `contains` is literal and case-sensitive; punctuation such as `.`, `(` and `/` need no escaping. Use `prefilter` for a **regex** instead; combining both is an error.
- Default `status` is `shadow`, default `severity` is `error` and default `threshold` is `0.8`. Shadow findings do **not** block CI.
- Run `jevcheck inspect --rule reliability/queue-ack src/handler.ts` to verify candidates before calling a model. Zero matches means no judgement: revisit file scope, filters and context.

JSON config shorthands are normalised to canonical AST selectors and regex prefilters **before** fingerprinting and evidence persistence. Configuration parsing rejects unknown keys at the top level and within rules, selectors, context, criteria, fixtures, confirmation fixtures, and mutants. A typo such as `contain` produces a path-specific error like `rules[0].contain: unknown field (did you mean contains?)` instead of silently changing rule behaviour. The nested `ast.rule` object is passed through to ast-grep so valid composite matcher syntax remains available; use its own grammar and validation rules. This is a **breaking configuration-validation change in v0.7.0**: correct any previously ignored fields before upgrading. The TypeScript `createJevCheck` API continues to accept canonical AST objects and regex prefilters.

### Advanced rule configuration

A qualified rule can add provenance, AST context, fixtures, mutants and other evidence controls:

~~~json
{
  "include": ["src/**/*.ts"],
  "exclude": ["**/*.test.ts"],
  "baselineFile": ".jevcheck/baseline.json",
  "replayFile": ".jevcheck/replay.json",
  "calibrationFile": ".jevcheck/calibration.json",
  "confirmationFile": ".jevcheck/confirmation.json",
  "evidenceFile": ".jevcheck/evidence.json",
  "driftThreshold": 0.1,
  "rules": [
    {
      "id": "security/no-sensitive-log",
      "status": "shadow",
      "severity": "error",
      "why": "Logs must not expose credentials or other sensitive values.",
      "source": "docs/security.md#logging",
      "projectWhen": { "globMatches": "src/**/*.ts" },
      "coveredBy": [
        { "id": "security-tests", "path": "tests/security/logging.test.ts" }
      ],
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
        "invalid": ["fixtures/no-sensitive-log/invalid/**/*.ts"],
        "confirmation": {
          "valid": ["fixtures/no-sensitive-log/confirmation/valid/**/*.ts"],
          "invalid": ["fixtures/no-sensitive-log/confirmation/invalid/**/*.ts"]
        }
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

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No blocking findings |
| `1` | Blocking finding or failed measurement/test command |
| `2` | Configuration, runtime, or provider error |

For normal checks, owned error findings **and incomplete evaluations of applicable owned/error rules** fail enforcement. A genuine rule with no matching candidates remains successful. Incomplete evaluation means applicable content could not be judged because of an unsupported AST language or a `chunkChars` bound. Shadow rules, owned warning rules, and measurement commands report advisory warnings instead. JSON diagnostics expose `code: "incomplete-evaluation"`; SARIF includes the diagnostic and marks execution unsuccessful for blocking incompleteness. Oversized semantic requests are never sent. For oversized AST matches and source lines, a deterministic `unless` exclusion is checked against **the skipped match or line**, never against unrelated source: excluded content is a genuine no-match, while other skipped candidates still fail closed.

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

## AST language support and native parsers

**Text/chunk selection and AST selection are different capabilities.** Any explicitly included UTF-8 source file can use text/chunk semantic candidates (with bounded context and optional prefilter), regardless of language. The default `include` pattern discovers only the extensions below; custom `include`, positional paths, and per-rule `files`/`exclude` can narrow or extend what is considered. Discovery does **not** imply an AST grammar, an AST match, or a model judgement.

| Extensions | Text/chunk semantic | Default discovery | AST inferred from extension | AST grammar |
| --- | --- | --- | --- | --- |
| `.js`, `.mjs`, `.cjs` | Yes | Yes | `javascript` | Built-in |
| `.ts`, `.mts`, `.cts` | Yes | Yes | `typescript` | Built-in |
| `.jsx`, `.tsx` | Yes | Yes | `tsx` | Built-in |
| `.html`, `.htm` | Yes | Yes | `html` | Built-in |
| `.css` | Yes | Yes | `css` | Built-in |
| `.cs` | Yes | Yes | `csharp` | `@ast-grep/lang-csharp` |
| `.py` | Yes | Yes | `python` | `@ast-grep/lang-python` |
| `.go` | Yes | Yes | `go` | `@ast-grep/lang-go` |
| `.java` | Yes | Yes | `java` | `@ast-grep/lang-java` |
| `.rs` | Yes | Yes | `rust` | `@ast-grep/lang-rust` |
| `.rb`, `.php`, `.vue`, `.svelte` | Yes | Yes | None | None (text/chunk only) |
| Other UTF-8 extensions (e.g. `.md`, `.json`) | Yes, when explicitly included | No | None | None by default |

HTML/HTM and CSS are **intentionally included** in the default source set because their built-in parsers support AST selection. Ruby/PHP/Vue/Svelte remain discoverable for text/chunk semantic checks but **are not AST languages in jevcheck**; do not assume Vue/Svelte single-file components are parsed as HTML/JS. `ast.language` overrides inference only when the *whole selected source* is compatible with that grammar, not as a universal fallback. All supported AST languages use `pattern`, `kind`, composite `rule`, and bounded `ast.context.ancestor` selection; the AST match is the focus, **not** proof of a violation.

**When an applicable `ast` rule reaches an extension without inference**, jevcheck produces an `incomplete-evaluation` diagnostic with the file, extension and remediation (scope the rule, switch to text/chunk selection, or opt into a genuinely compatible grammar). It never silently treats this as a successful zero-match: owned/error rules fail enforcement; shadow and owned/warning rules report advisory warnings. A grammar that *is* inferred but has an incompatible selector or cannot load is also incomplete, not a zero-match. For mixed-language rules, restrict `files` to the intended grammars and use grammar-correct selectors; inspect with `jevcheck inspect --rule <id> <path>` before enforcement. A real zero-match from a valid selector is still successful.

Built-in grammars come from `@ast-grep/napi` (`^0.45.3`). The pinned dynamic packages are `@ast-grep/lang-csharp` (`0.0.6`), `@ast-grep/lang-python` (`0.0.6`), `@ast-grep/lang-go` (`0.0.6`), `@ast-grep/lang-java` (`0.0.7`) and `@ast-grep/lang-rust` (`0.0.7`).

### Native parser installation

The five dynamic parsers are regular runtime dependencies. At the **first dynamic-language request**, jevcheck independently loads each package and resolves its native-library metadata. Missing packages and failed library-path getters are recorded **per language**, then the remaining loadable grammars are registered in **one batch, once per process**. A missing Go pack, for example, does not stop Python AST checks; a rule targeting Go still reports an `incomplete-evaluation` error with its rule ID, package, platform/architecture and installation guidance. Built-in JS/TS/TSX/HTML/CSS parsers do not trigger or depend on dynamic registration.

**Limit of isolation:** [`@ast-grep/napi` requires a single registration call](https://ast-grep.github.io/guide/api-usage/js-api#use-other-language); later calls may be ignored. If a pack passes metadata loading but native registration itself fails (for example, an incompatible binary), that single batch can still fail for **all attempted dynamic grammars**. The resulting error lists the affected packages, but NAPI cannot reliably identify the individual failing library. jevcheck does not retry registration, substitute another parser, or convert failure into a successful no-match. Repair the installation and start a new process; avoid relying on dynamically installing parsers into an already-running process.

- Use `npm ci` or `npm install` with lifecycle scripts enabled. This repository approves the five pinned parser postinstalls through `allowScripts` for npm 11+. The **consumer's root project** may need its own script approvals. Do not assume `--ignore-scripts` works on every platform.
- With pnpm 10+, explicitly approve builds for the required `@ast-grep/lang-*` packages (`pnpm approve-builds`, or `pnpm add --allow-build=@ast-grep/lang-python ...`).
- Native prebuilds are platform-specific. Without a matching prebuild, `tree-sitter-cli` and platform build tools may be necessary.
- Linux, macOS and Windows CI installs dependencies, exercises all supported parser registrations and tests provider-free inspection. Other platforms/architectures are not certified by this CI matrix.

Adding every upstream grammar by default would increase package downloads, native-install surface and platform risk. The registry deliberately includes a small supported set; new languages require focused selector/context/range tests and documentation. JSON/YAML/TOML and less common parsers can be evaluated as a separate follow-up rather than implied support.

See the [runnable C# walkthrough](../examples/csharp-queue/README.md) and [multilanguage AST examples](../examples/multilanguage-ast/README.md).

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

### Inspect runtime policy (provider-free)

`jevcheck inspect` previews whether **enforcement would call a semantic judge** for each selected rule and source file in the current revision. It never makes a provider request or decides whether a violation exists:

~~~sh
npx jevcheck inspect src/handler.ts --rule reliability/queue-ack
npx jevcheck inspect src/handler.ts --format json
npx jevcheck inspect src/handler.ts --preview-skipped
~~~

The output has one rule/file policy entry with `execution` (`semantic`, `covered`, or `inapplicable`), a human-readable `reason`, selector description, candidate count, and selector diagnostics. JSON exposes these in `rules[]`; `inspections[]` contains bounded requests for candidates actually eligible for semantic judging. `diagnostics[]` contains selector diagnostics from eligible rules only. A rule that matches no candidates is **not** the same as a policy-skipped rule.

- `semantic` means the rule is eligible for a provider judgement **if** its selector finds candidates. It does not mean a violation was found. Project conditions, accepted ADRs and fingerprinted coverage are resolved before selection.
- `covered` means reviewed coverage authorizes a skip. For shadow rules this is a reviewed declaration (**not** verified execution); for owned rules all checks must also actually pass in the same GitHub Actions job/attempt/checkout. Missing/stale evidence falls back to `semantic`; failed CI checks block owned enforcement.
- `inapplicable` means a file is out of the rule's files/exclude scope, a project condition is false, or an opt-in ADR is retired or invalid.
- `--preview-skipped` runs selectors even for covered/inapplicable rules, marking candidate requests `previewOnly: true` with an explicit warning in stylish output. These **hypothetical** requests are never counted as enforcement requests, and their selector diagnostics do not cause an inspect failure.
- `--staged` and `--changed --base <ref>` use the same isolated snapshot for policy, source, and recorded evidence as `check`.

The JavaScript `inspectSource` / `inspectSources` APIs return Promises as of v0.8.0. For custom evidence paths, pass `config` and `projectRoot`; or pass the `ruleEvidenceReports` already produced by `evaluateConfiguredRuleEvidence` on the same revision. Do not use a report from an unrelated snapshot.
