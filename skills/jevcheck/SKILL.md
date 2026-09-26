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

## Calibrate and check drift

Record labelled fixture probabilities as durable evidence:

~~~sh
jevcheck test --record
~~~

Later, re-ask every fixture without the answer cache and compare against that calibration:

~~~sh
jevcheck test --drift
~~~

Treat a `THIN` passing fixture (0.05 or less from the threshold) as weak evidence that deserves review. Calibration recording and drift both bypass the answer cache.

Drift compares probabilities only when the exact semantic request hashes and configured threshold are unchanged. If the fixture/rule/context or threshold changed, jevcheck reports the calibration as `STALE`; re-record it instead of mixing changed policy with model drift. Significant drift, stale calibration, and added/removed fixtures fail `test --drift` so CI cannot silently ignore changed evidence.

Do not confuse calibration with replay:
- replay reuses prior semantic decisions and never calls a provider
- drift intentionally calls the provider again and measures movement

## Measure mutation recall

Use mutation recall after fixtures/calibration when you need evidence that a rule still catches representative mistakes in real repository context.

Configure deterministic JSON-safe mutants on the rule, for example:

~~~json
{
  "mutants": [{
    "id": "drop-limit",
    "pattern": "/\\.limit\\([^)]*\\)/g",
    "replacement": "",
    "replaceAll": true
  }]
}
~~~

Then run:

~~~sh
jevcheck recall
jevcheck recall --sample-size 20
~~~

Interpretation:

- files are sampled deterministically, not by filesystem order
- repository files are never changed on disk
- files already violating before mutation are excluded from the recall denominator
- a mutation that defeats the rule's prefilter/candidate selector is a recall miss
- low recall can mean the semantic question is weak **or** deterministic narrowing is too aggressive

Do not promote a rule to `owned` from fixture accuracy alone. Mutation recall is evidence that the rule survives realistic repository context. Full-scope recall is persisted and evaluated by the graduation gate, whose default minimum recall is 0.90.

## Probe semantic robustness

Use robustness testing to check whether model-visible text that should not change the label can still move the judgement:

~~~sh
jevcheck test --robustness
~~~

The probe inserts deterministic comments immediately beside the semantic focus for labelled fixtures. It currently tests direct instruction injection, false approval/authority claims, and unrelated nearby context. Inspect both probability movement and classification flips.

Robustness complements mutation recall:
- mutation recall asks whether meaningful semantic changes are detected
- robustness asks whether label-preserving changes are ignored

The result is persisted in `.jevcheck/evidence.json` with a freshness identity. It is advisory rather than a graduation blocker: a flip should be investigated, but do not weaken the rule or threshold merely to make the probe green. Unsupported fixture languages are skipped with a diagnostic instead of applying a potentially semantic-changing transform.

## Audit rule evidence

Before treating a semantic rule as reviewer-of-record, inspect its evidence without making new model calls:

~~~sh
jevcheck rules audit
jevcheck rules audit --format json
~~~

The audit distinguishes:

- threshold separation across current labelled fixture probabilities; if valid and invalid ranges overlap, no single threshold can fix the rule
- persisted robustness results and stale robustness evidence
- missing valid/invalid fixtures
- failing fixture evidence
- thin passing margins
- missing versus stale calibration
- drift evidence
- mutation recall, including unmeasured or zero-judged mutants
- rule source/provenance

Current fixture semantic identities are recomputed deterministically. Drift and full-scope recall measurements are persisted in `.jevcheck/evidence.json` with freshness identities. Mutation identities also bind the recorded per-mutant outcomes, so partial or inconsistent artifact edits fail closed. If rule semantics, calibration, relevant mutation inputs, sample size, provider/model identity, or recorded outcomes change without a fresh measurement, expect the audit to report stale evidence rather than silently reuse it.

Treat these hashes as freshness/integrity checks, not cryptographic signatures. Config and committed evidence live inside the same repository trust boundary.

The audit is advisory, but normal checks and replay enforce the same blockers for `owned` rules. Status is never rewritten automatically.

## Graduate a rule to owned

Keep new rules in `shadow` while evidence is being built:

~~~sh
jevcheck test --record
jevcheck test --drift
jevcheck test --robustness
jevcheck recall
jevcheck rules audit
~~~

Only change `status` to `owned` when audit reports `Ready for owned: yes`. Normal checks and replay fail closed if an owned rule's required evidence is missing, stale, or failing. Robustness warnings are deliberately advisory and therefore do not change `Ready for owned` yet.

Default policy requires valid and invalid fixtures, current calibration, no thin margins, clean drift, mutants with at least 0.90 recall and non-zero judged samples, and `source` provenance. Global `graduation` config can adjust those explicit requirements; do not weaken them merely to make CI pass.

A scoped recall such as `jevcheck recall src/foo.ts` is exploratory and is not persisted as graduation evidence. Run full-scope `jevcheck recall` to refresh the committed evidence artifact.

Measurement commands can still run while an owned rule is blocked so evidence can be repaired. They preserve the configured status but do not let it act as a blocking reviewer during measurement.

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
jevcheck test --record
jevcheck test --drift
jevcheck recall
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
