# jevcheck

**Turn recurring code-review judgements into testable, repeatable semantic lint rules.**

Traditional linters are great at enforcing what can be proved from syntax and types. General-purpose AI review can notice more, but its findings are often difficult to reproduce, calibrate, or enforce consistently. `jevcheck` sits between them: **deterministic code selects a narrow candidate; Jev answers one bounded yes/no question; deterministic policy decides what happens next**.

- Start with advisory (`shadow`) findings; never block a build on an unqualified rule.
- Inspect exactly what would be sent to a model **without an API key**.
- Test rules against labelled examples, track drift and recall, and promote them to blocking (`owned`) checks only when the evidence is sound.
- Run the same rule over source files, staged changes, branch diffs, or CI.
- Gate rules on declared Node, .NET, or Go dependencies using [manifest-aware `projectWhen.hasDependency`](docs/concepts.md#declared-dependency-predicates) (no package-manager execution).

`jevcheck` uses [`@mhingston5/jev-cli`](https://github.com/mhingston/jev-cli) for provider selection. Node.js 20+ is required.

## See why it exists: a queue acknowledgement bug

A worker API returns `202 Accepted` to a caller once a job has been published to its queue. A refactor catches a publish failure to log it, but still returns success. A reviewer catches the mistake once; the team wants to prevent similar regressions without asking an open-ended AI reviewer to reinterpret its standards on every PR.

The [queue acknowledgement walkthrough](examples/queue-ack/README.md) includes the **actual source**, a deliberately broken handler, a corrected fixture, a scoped rule, and commands you can run locally. It is a small, production-inspired illustration, **not a claim of a real incident or validated model accuracy**.

### Try the rule without calling a model

From a checkout of this repository:

~~~sh
npm ci
npm run build
node dist/cli.js inspect examples/queue-ack/src/handler.ts \
  --config examples/queue-ack/jevcheck.config.json \
  --rule reliability/no-success-after-publish-failure
~~~

`inspect` requires no provider credentials. It reports whether a rule is eligible for semantic checking, deterministically covered, or inapplicable (with a reason), before showing selected bounded requests. Use `--preview-skipped` to see hypothetical candidates for policy-skipped rules. **Inspection does not assert a violation.** See [inspect policy semantics](docs/reference.md#inspect-runtime-policy-provider-free). To ask a model for a judgement, configure a provider and run the same rule in shadow mode; see the [walkthrough](examples/queue-ack/README.md#3-run-a-semantic-check-optional).

To install it in your own repository:

~~~sh
npm install --save-dev @mhingston5/jevcheck
~~~

Create a repository-local `jevcheck.config.json` based on a concern your team has actually reviewed:

~~~json
{
  "include": ["src/**/*.ts"],
  "rules": [
    {
      "id": "reliability/queue-ack",
      "ast": "function_declaration",
      "contains": "queue.publish(",
      "question": "Can this handler return success when queue publication fails without recovery?"
    }
  ]
}
~~~

`ast` as a string means an AST **node kind**, and `contains` matches literal text without regex escaping. Rules default to advisory `shadow` mode. Run `npx jevcheck inspect --rule reliability/queue-ack src/handler.ts` to preview candidates and the exact model request without an API key. For AST patterns, regex filtering and evidence controls see the [configuration reference](docs/reference.md#configuration-example).

[Rule-authoring guidance](docs/concepts.md#design-the-invariant-before-writing-config) explains how to decide if that concern belongs here. [Rule-authoring guidance](docs/concepts.md#design-the-invariant-before-writing-config) explains how to decide if that concern belongs here.

## When should I use it?

| Situation | Better tool | Why |
| --- | --- | --- |
| Forbid an import, detect a syntactic call, enforce formatting or types | ESLint, ast-grep, compiler, tests | Exact checks are cheaper and more reliable |
| Enforce a recurring **bounded behavioural or architectural judgement** for a known code candidate | **jevcheck** | Semantics matter and the candidate/evidence can be scoped |
| Ask what is wrong with an unfamiliar subsystem or suggest broad improvements | Human/AI code review | The desired judgement is exploratory, not a stable binary invariant |
| Need interprocedural runtime behaviour that the selected context cannot establish | Tests, tracing, specialised analysis | A bounded model question cannot invent missing evidence |

Three candidate use cases worth exploring:

- **Behavioural regression** — a handler acknowledges accepted work after publication fails (the runnable example).
- **Architecture decision** — a scoped operation bypasses a service boundary described by an ADR, provided the selected context can prove it. [Architecture/ADR guidance](docs/concepts.md#architecture-decisions-as-scoped-semantic-rules).
- **Recurring review judgement** — a defined failure response exposes internal implementation details, with explicit safe/unsafe examples.

A rule is **not** justified just because a model can answer it. First check whether deterministic code or a test can prove the invariant. If a narrow focus cannot show the relevant facts, do not build a semantic rule around it.

## How adoption works

~~~text
real review concern -> write invariant -> select bounded code -> inspect (offline)
                   -> shadow findings -> labelled fixtures -> measure
                   -> audit evidence -> owned/CI (only if dependable)
~~~

You can stop at `shadow` and keep a useful advisory check. `owned` error rules block only when the documented evidence gates are met, and fail closed when that evidence goes stale. They also **fail closed when applicable code cannot be evaluated** (e.g. an unsupported AST language or `chunkChars` bound); genuine zero-matches remain successful. Incomplete evaluation is warning-only for shadow and owned warning rules. Run `jevcheck rules audit` before promoting a rule.

| Goal | Command |
| --- | --- |
| Inspect a rule without calling Jev | `npx jevcheck inspect --rule <id> src/file.ts` |
| Run repository rules | `npx jevcheck` |
| Check staged changes | `npx jevcheck --staged` |
| Review branch changes | `npx jevcheck --changed --base origin/main` |
| Preview ownership/evidence readiness | `npx jevcheck rules audit` |
| Produce code-scanning results | `npx jevcheck --changed --base origin/main --format sarif` |

**Revision consistency:** `--staged` evaluates the Git index, including staged rules, manifests, ADRs, fixtures and evidence; unstaged edits cannot change the judgement. `--changed --base <ref>` selects paths changed by `<ref>...HEAD` and evaluates their **committed HEAD versions**, not local edits. Both modes require policy artifacts to exist in that revision (ignored/untracked evidence does not count). See [Git snapshot semantics](docs/reference.md#git-snapshot-semantics).
Provider configuration: export `TYPESAFE_API_KEY` (default provider), or set `OPENROUTER_API_KEY` plus `JEV_PROVIDER=openrouter`. Never put credentials in rules. Model-visible code is sent to your selected provider: exclude secrets, private keys and sensitive source. See [provider details](docs/reference.md#provider-configuration).

## Documentation

- **[Runnable queue acknowledgement walkthrough](examples/queue-ack/README.md)** — code, config, inspect, safe/unsafe fixtures, optional provider run.
- **[What makes a good semantic rule?](docs/concepts.md)** — applicability, architecture decisions, deterministic coverage, context sufficiency.
- **[Rule lifecycle and evidence](docs/rule-lifecycle.md)** — fixtures, calibration, drift, recall, robustness, confirmation, baselines and replay.
- **[CLI and configuration reference](docs/reference.md)** — provider options, commands, configuration, exit codes, API and development.

C#, Python, Go, Java, and Rust support language-specific AST selection using `ast.language` or automatic `.cs`, `.py`, `.go`, `.java` and `.rs` detection. See the [supported-language reference](docs/reference.md#ast-language-support-and-native-parsers), [multilanguage AST examples](examples/multilanguage-ast/README.md), and the [C# walkthrough](examples/csharp-queue/README.md). The C# walkthrough includes safe/unsafe fixtures, native parser installation requirements, and an offline `inspect` example.

**Source discovery is not AST support.** With no `include` override, jevcheck discovers JS/TS, Python, Go, Rust, Java, C#, HTML (`.html`/`.htm`), CSS, Ruby (`.rb`), PHP (`.php`), Vue (`.vue`) and Svelte (`.svelte`) files. All discovered UTF-8 files can be examined with text/chunk semantic selectors. Ruby, PHP, Vue and Svelte have **no built-in AST inference or grammar**: a rule using `ast` on them emits `incomplete-evaluation`, blocking an applicable owned/error rule rather than silently passing. Scope mixed-language AST rules with `files`/`exclude` or explicitly configure `ast.language` **only for compatible syntax**. See the [discovery/AST matrix](docs/reference.md#ast-language-support-and-native-parsers).

The bundled [agent skill](skills/jevcheck/SKILL.md) guides automated rule authoring without changing the deterministic/model boundary.

MIT licensed.
