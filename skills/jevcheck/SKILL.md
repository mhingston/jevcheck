# Jevcheck

Use this skill when a repository uses jevcheck for semantic linting or when deciding whether a review concern should become a jevcheck rule.

## Boundary

Use deterministic tooling first. Syntax, types, exact data flow, formatting, dependency policy, and mechanically provable conditions belong in ordinary linters, compilers, tests, or code.

Use jevcheck only for bounded semantic judgments where the code is available but the answer depends on meaning or intent.

Good examples:

- Does this logging statement expose a sensitive value?
- Can this retry path continue without a meaningful bound?
- Does this handler surface an internal implementation detail to an external caller?

Poor examples:

- Is this import unused?
- Is this method longer than 50 lines?
- Does this file contain eval?
- Should we redesign this subsystem?

## Authoring a rule

1. Phrase one atomic Noul question. YES must always mean a violation.
2. Narrow candidates deterministically. Prefer an `ast` selector when a structural construct is identifiable; otherwise use `files`, `exclude`, `prefilter`, and `unless`.
3. For `ast`, define exactly one selector: `pattern`, `kind`, or `rule`. Let language infer from the file extension unless an explicit supported language is required.
4. Keep AST focus precise. The matched node is what Jev judges; `context.ancestor` and surrounding lines are evidence only.
5. Keep all context bounded. Do not increase `chunkChars` merely to avoid a skipped oversized construct without checking the token/cost implications.
6. Add true and false criteria when the semantic boundary is easy to confuse.
7. Add both valid and invalid fixtures.
8. Start the rule in `shadow` status.
9. Inspect false positives, false negatives, probability margins, and model drift before making it `owned`.
10. Keep thresholds, CI behavior, suppressions, baselines, and other policy in code rather than asking the model to decide them.

## AST-aware narrowing

Use `ast` when a candidate can be identified structurally. Supported selectors are:

~~~json
{ "pattern": "console.log($A)" }
{ "kind": "call_expression" }
{ "rule": { "kind": "call_expression" } }
~~~

JavaScript, TypeScript, TSX, HTML, and CSS are supported by the bundled parser. Common extensions infer the language automatically. `context.ancestor` can include the nearest related ancestor while preserving the original matched node as the exact focus.

Do not turn a deterministic structural condition into a Jev question. If ast-grep alone proves the violation, use ast-grep or an ordinary linter directly instead of jevcheck.

## Replay before re-asking

Use replay when evaluating deterministic rule/config changes against decisions already made by Jev:

~~~sh
jevcheck record
# change threshold/status/severity or other deterministic policy
jevcheck replay
~~~

The replay corpus is separate from the answer cache and can be committed. Replay is strict and offline: if the semantic question, criteria, focused code, or model-visible context changed, expect a replay miss rather than silently reusing an incompatible decision or calling a provider.

A replay hit is reproducibility evidence, not correctness evidence. Do not use replay to justify promoting a weak rule to `owned`; labelled fixtures, drift checks, and recall evidence are still required.

## Suppressing known findings

Use a committed baseline for accepted existing backlog:

~~~sh
jevcheck baseline
~~~

Use an inline suppression only for a local intentional exception, and require a reason:

~~~ts
// jevcheck-ignore security/no-sensitive-log -- logger wrapper redacts this value
console.log(secret);
~~~

Do not add a suppression simply to make CI green. Confirm that the exception is durable and explain why it is safe.

## Running

Use the smallest relevant scope:

~~~sh
jevcheck --staged
jevcheck --changed
jevcheck --changed --base origin/main
jevcheck test
jevcheck record
jevcheck replay
jevcheck list
~~~

For code-scanning integration:

~~~sh
jevcheck --changed --base origin/main --format sarif > jevcheck.sarif
~~~

A shadow finding is advisory. Only an owned error finding is blocking. Suppressed findings remain visible in JSON output for auditability.

Do not treat a high Jev probability as proof. It is a semantic signal that should be evaluated against labelled fixtures and real review outcomes.
