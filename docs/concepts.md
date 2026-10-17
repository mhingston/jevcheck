# Choosing good semantic rules

Use this guide to decide *whether* to use jevcheck and to scope one binary invariant. For a runnable onboarding example, start with the [queue acknowledgement walkthrough](../examples/queue-ack/README.md).
## Linter or reviewer?

`jevcheck` is primarily a **semantic linter**. Automated code review is one way of running that linter.

The rule model does not change between the two uses. A rule still has the same deterministic candidate selection, bounded semantic judgement, severity, status, threshold, baselines, suppressions, evidence, and exit-code policy. The difference is simply **what code you run it against and when you run it**.

| Use | Typical command | What it means |
| --- | --- | --- |
| Local semantic lint | `npx jevcheck "src/**/*.ts"` | Check a source set during development |
| Repository/CI lint | `npx jevcheck` | Enforce configured semantic lint rules across the repository scope |
| Staged lint | `npx jevcheck --staged` | Check exactly what is about to be committed |
| Working-tree review | `npx jevcheck --changed` | Review changed and untracked code |
| Pull-request / branch review | `npx jevcheck --changed --base origin/main` | Review only the branch diff |
| Code scanning | `npx jevcheck --changed --base origin/main --format sarif` | Emit SARIF for a separate CI/code-scanning upload step |

This means you can adopt `jevcheck` progressively:

- use **shadow** rules as advisory semantic lint while you learn where a rule is useful;
- run the same rules locally, in pre-commit/pre-push hooks, or in CI;
- use diff-scoped commands for automated code review;
- promote well-evidenced rules to **owned** when they are trustworthy enough to block either linting or review.

An owned `error` finding is blocking wherever the check runs. It is not inherently a pull-request concept.

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

### Design the invariant before writing config

Before adding a rule, write down five things in plain language:

1. **Invariant** — the single binary fact you want enforced.
2. **Applicability** — when that fact is relevant. Prefer conditions you can encode deterministically with file globs, AST selectors, `prefilter`, or `unless`.
3. **Scope rationale** — why the selected focus contains enough evidence to answer the question without widening into general review.
4. **Deterministic coverage** — whether a compiler, test, linter, ast-grep rule, or other exact check can already prove the condition.
5. **Semantic boundary** — what makes YES a violation and NO acceptable, including edge cases worth capturing in `criteria`.

This avoids a common failure mode: starting from a broad review preference and then trying to make the model discover both *where* the rule applies and *what* the rule means.

A useful authoring test is:

~~~text
Can deterministic code decide this exactly?
  yes -> use deterministic tooling
  no  -> can deterministic code identify the right candidate?
          no  -> reshape the concern before using jevcheck
          yes -> ask one bounded semantic question about that candidate
~~~

Do not duplicate deterministic enforcement with a semantic rule just because Jev can also answer it. If an exact check exists, keep that check as the source of truth and reserve jevcheck for the residual semantic gap.

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

## Deterministic applicability and coverage

Before selecting semantic candidates, jevcheck can now eliminate two kinds of unnecessary model work.

### Repository applicability with `projectWhen`

Use `projectWhen` when a reusable rule only makes sense for some repositories. It is evaluated deterministically at repository scope before semantic enforcement.

~~~json
{
  "id": "express/actionable-errors",
  "projectWhen": {
    "allOf": [
      { "packageJsonHasDep": "express" },
      { "globMatches": "src/**/*.ts" }
    ]
  },
  "question": "Does this user-facing error fail to tell the user what to do next?"
}
~~~

Supported predicates are:

- `hasDependency` — ecosystem-neutral, declaration-only dependency check (Node.js, .NET, Go; details below).
- `packageJsonHasDep` — backwards-compatible shorthand for `{ "hasDependency": { "ecosystem": "node", "name": "..." } }`; inspects root `package.json` only.
- `fileExists` — checks a repository-relative path.
- `globMatches` — checks whether a repository-relative glob matches at least one file.
- `anyOf`, `allOf`, and `not` — compose predicates without introducing another model decision.


#### Declared dependency predicates

Use the same condition shape for supported ecosystems, with a **case-sensitive package name** for Node and Go and a **case-insensitive package ID** for NuGet:

~~~json
{
  "projectWhen": {
    "hasDependency": {
      "ecosystem": "dotnet",
      "name": "Microsoft.Extensions.Http",
      "scope": "workspace"
    }
  }
}
~~~

~~~json
{
  "projectWhen": {
    "allOf": [
      { "hasDependency": { "ecosystem": "go", "name": "golang.org/x/sync" } },
      { "not": { "fileExists": "docs/legacy-exemption.md" } }
    ]
  }
}
~~~

- `ecosystem` (required): `node`, `dotnet`, or `go`.
- `name` (required): an exact declared dependency name, not a version constraint or glob.
- `scope` (optional): `root` (default) checks repository-root manifests; `workspace` checks **any** root or nested project manifest (monorepo-wide), not only the source file under review. Match means **any** manifest declares the package. Ignored generated/vendor directories include `node_modules`, `vendor`, `target`, `obj`, `bin`, `dist` and `.git`.

| Ecosystem | Read-only declarative manifests | What counts as declared |
| --- | --- | --- |
| Node | `package.json` | Keys in `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies` |
| .NET | `*.csproj`, `Directory.Packages.props` | Literal `<PackageReference Include="...">` or `<GlobalPackageReference Include="...">` values. `PackageVersion` alone does **not** add a dependency |
| Go | `go.mod` | Single and block `require` directives, including `// indirect` declarations |

These checks mean **textually declared**, not installed, resolved, active under build conditions, or reachable at runtime. They do not run build tooling, execute Gradle/MSBuild scripts, contact registries or consult lockfiles. Dynamic NuGet property expressions (for example `$(PackageName)`) are not expanded. The .NET reader recognises static MSBuild package reference tags; it is not a full MSBuild/XML evaluator. Workspace match does not imply the checked file belongs to the declaring subproject: use per-rule `files` for that scoping. Python TOML, Cargo and Maven/Gradle adapters are intentionally not part of this first supported set.

Missing manifests return false; present but invalid manifests fail with a path-specific error rather than becoming a false match or silently passing through `not`. All selected manifests are examined before returning, so a valid match cannot hide a malformed sibling. Files over 2 MiB and symlinked manifests are rejected.


When the condition is false, normal enforcement and replay skip the rule entirely. Measurement commands still exercise the semantic rule so fixtures, replay corpora, and robustness evidence can be maintained independently of the current repository state.

### Architecture decisions as scoped semantic rules

Architecture decision records (ADRs) can supply *provenance* for a bounded semantic rule, without making the model interpret an entire architecture document. For example, suppose ADR-004 requires customer-record writes to go through the customer service rather than accessing persistence directly.

Add **opt-in** lifecycle metadata to the repository-local decision, in `docs/adr/004-customer-writes.md`:

~~~md
---
jevcheck-adr: true
status: accepted
---

# ADR-004: Customer record writes

Customer-record writes must pass through the customer service so that auditing
and validation are applied consistently.
~~~

Then link the rule to that decision in `jevcheck.config.json`:

~~~json
{
  "include": ["src/**/*.ts"],
  "rules": [
    {
      "id": "architecture/customer-write-boundary",
      "source": "docs/adr/004-customer-writes.md",
      "why": "Customer writes must pass through the service that owns auditing.",
      "status": "shadow",
      "severity": "warning",
      "projectWhen": {
        "fileExists": "src/customers/customer-service.ts"
      },
      "files": ["src/customers/**/*.ts"],
      "ast": {
        "pattern": "await $CALL",
        "context": { "ancestor": { "kind": "function_declaration" } }
      },
      "question": "Does this awaited operation write a customer record directly to persistence instead of going through the customer service?",
      "criteria": {
        "true": "The selected operation performs a customer-record write while bypassing the customer service.",
        "false": "It delegates to the customer service, performs no customer-record write, or lacks enough evidence of a bypass."
      }
    }
  ]
}
~~~

This example is a starting point: refine the AST selection and context against real code, inspect the request, and use labelled valid/invalid fixtures before relying on the judgement. A direct syntactic prohibition should instead use a deterministic linter.

Run a provider-free audit:

~~~sh
npx jevcheck rules audit
npx jevcheck rules audit --format json
~~~

For an opted-in local ADR, the audit reports its status, linked source, declared `files`/`exclude` scope, number of currently discovered source files matching that scope, and `projectWhen` condition. These are *explanations of configured applicability*, not semantic proof that the ADR's prose and the rule agree.

| Scenario | Result |
| --- | --- |
| ADR is `accepted`, project condition holds, changed file is under `src/customers/**` | Rule may evaluate the selected candidate, subject to normal evidence policy |
| Change is under `src/payments/**` | Rule does not select that file; the unrelated decision does not govern it |
| Project does not contain the customer service | `projectWhen` makes the rule inapplicable |
| ADR has `status: superseded` (optionally `superseded-by: ADR-009`) | Audit reports a blocker; normal check/replay skips even a shadow rule, and an owned rule fails its evidence gate |
| Opted-in ADR has a missing, unknown, or conflicting status | It is not authoritative; audit blocks it from rule enforcement |

Only a repository-local `source` document with a top-of-file frontmatter marker `jevcheck-adr: true` activates this lifecycle check, regardless of file extension (for example, `.md` or `.markdown`). The supported statuses are `accepted`, `proposed`, `superseded`, `withdrawn`, `rejected`, and `deprecated`; **only `accepted` is active**. An absent or `false` marker is ordinary provenance; a duplicate marker containing `true`, or an unterminated opted-in header, is invalid and non-authoritative. External URLs are provenance links only: jevcheck cannot locally verify their status or freshness.

Jevcheck does **not** parse the body of an ADR to discover architecture scope, conflicts, or requirements. Keep applicability deterministic with `projectWhen`, `files`, `exclude` and candidate selectors. The existing local-source fingerprint ties drift/robustness evidence to the ADR's contents; changing the decision can make that evidence stale. Use `rules audit` before promotion to `owned`, and use ordinary tests or static analysis for exactly provable constraints.

### Deterministic coverage with `coveredBy`

Use `coveredBy` when an existing test or linter already enforces the same invariant exactly:

~~~json
{
  "id": "security/no-sensitive-log",
  "coveredBy": [
    {
      "id": "eslint-security-rule",
      "path": "eslint.config.js"
    },
    {
      "id": "security-regression-tests",
      "path": "tests/security/logging.test.ts"
    }
  ],
  "question": "Does this logging call expose a credential or other sensitive value?"
}
~~~

After reviewing that those files really provide deterministic coverage, record their current fingerprints:

~~~sh
npx jevcheck coverage record
~~~

The fingerprints are stored in the existing `.jevcheck/evidence.json` artifact. During normal enforcement:

- if every declared coverage source still matches its recorded fingerprint, the rule reports as `covered` and Jev is skipped;
- if coverage is missing, unreadable, changed, or has not been recorded, jevcheck surfaces the stale coverage and falls back to semantic evaluation;
- an owned rule therefore still fails closed if its deterministic coverage goes stale and its semantic fallback evidence is not healthy.

`coveredBy` is a provenance/freshness contract, not a test runner. Jevcheck does not execute the referenced linter or test. Recording coverage means you have reviewed that those deterministic checks enforce the invariant; do not use `coverage record` merely to silence semantic checks after an unrelated change.

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

Language is inferred for JavaScript, TypeScript, TSX, HTML, CSS, C#, Python, Go, Java and Rust. You can override it with `ast.language` only for compatible source syntax. Default source discovery also includes Ruby, PHP, Vue and Svelte **for text/chunk selection**, not for AST parsing; unsupported AST extensions yield an incomplete evaluation. See the [discovery and parser matrix](reference.md#ast-language-support-and-native-parsers).

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

### Context sufficiency and trust boundary

Jev can only judge the evidence supplied to it. Give each rule the smallest deterministic context that is sufficient to answer its bounded question.

- Include surrounding code only when it materially changes the judgement.
- Do not send secrets, credentials, private keys, environment files, generated output, vendored code, or unrelated repository content.
- Model-visible source and context are sent to the configured Jev provider. Treat that provider as part of the trust boundary for any code you submit.
- If the selected candidate does not contain enough evidence for a defensible YES/NO judgement, improve the deterministic selector or bounded context, or do not apply the rule there.
- Do not add a second model judgement that asks whether the first judgement is applicable.

Do not solve insufficient context by turning a rule into an open-ended review prompt or by continuously widening its scope. A jevcheck rule should remain a narrow semantic question with stable meaning.
Context is evidence, not permission to broaden the question. Nearby code may help interpret the exact focus, but must not become an independent reason to report a violation.
