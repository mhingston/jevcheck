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

## Deterministic applicability and coverage

Before spending a semantic call, ask whether the rule is relevant to this repository and whether deterministic enforcement already owns the invariant.

Use `projectWhen` for repository-level applicability that can be decided from committed structure:

- `packageJsonHasDep`
- `fileExists`
- `globMatches`
- `anyOf`, `allOf`, and `not`

Do not turn applicability into a second model question. A false `projectWhen` condition skips normal semantic enforcement; measurement workflows may still evaluate the rule so its fallback evidence remains maintainable.

Use `coveredBy` only when a named test or linter really enforces the same invariant deterministically. Each coverage link has a stable `id` and a repository-relative `path`. After reviewing that coverage, record its fingerprints with:

~~~sh
jevcheck coverage record
~~~

Fresh recorded coverage skips the semantic judge. Missing, unreadable, changed, or unrecorded coverage falls back to the semantic rule and appears in `jevcheck rules audit`.

Treat `coverage record` as an evidence review action, not a green-CI button. Jevcheck fingerprints the referenced enforcement files but does not execute them or prove that they are logically equivalent to the semantic rule. If a coverage source changes, review whether it still enforces the invariant before refreshing the fingerprints.

## Authoring a rule

Classify the concern before encoding it:

- **DIRECT** — the undesirable condition is externally defined and visible in the bounded evidence; encode it.
- **NEEDS SHAPING** — the intent is useful but terms such as simple, safe, clean, idiomatic, adequate, or well-designed do not yet have observable criteria; sharpen the boundary first.
- **NOT FOR JEV** — deterministic tooling can prove it better, required evidence is unavailable, it is procedural guidance, or it asks the evaluator to invent a quality standard; keep it outside jevcheck.

Then:

1. State the invariant in one sentence before writing config.
2. State when the invariant is applicable, and encode as much of that applicability as possible with deterministic selectors rather than model judgement.
3. State why the chosen focus is the right evaluation scope: it should contain enough evidence to answer the question without turning nearby context into an independent source of violations.
4. Check whether an existing compiler rule, test, linter, ast-grep rule, or other deterministic check already proves the invariant. If it does, use that instead of jevcheck.
5. Phrase one atomic Noul question. YES must always mean a violation.
6. Narrow candidates deterministically. Prefer an `ast` selector when a structural construct is identifiable; otherwise use `files`, `exclude`, `prefilter`, and `unless`.
7. For `ast`, define exactly one selector: `pattern`, `kind`, or `rule`. Let language infer from the file extension unless an explicit supported language is required.
8. Keep AST focus precise. The matched node is what Jev judges; `context.ancestor` and surrounding lines are evidence only.
9. Keep all context bounded. Do not increase `chunkChars` merely to avoid a skipped oversized construct without checking the token/cost implications.
10. Add true and false criteria when the semantic boundary is easy to confuse.
11. Add both valid and invalid development fixtures.
12. Reserve separate valid and invalid confirmation fixtures that will not be used to author the rule or choose its threshold.
13. Start the rule in `shadow` status.
14. Inspect false positives, false negatives, probability margins, and model drift before making it `owned`.
15. Keep thresholds, CI behavior, suppressions, baselines, and other policy in code rather than asking the model to decide them.
16. Ensure the deterministically selected candidate contains enough evidence to answer the bounded question. If it does not, improve or narrow the context rather than adding a second model call to judge applicability.
17. Stop once the rule has sufficient evidence. Do not broaden context, weaken graduation policy, or tune thresholds merely to make the measured results look better.

## Context sufficiency and trust boundary

A semantic rule is only as defensible as the evidence supplied to it. The model should only see context that is relevant to the exact semantic focus, and nearby code can provide evidence, but it must not become an independent source of violations outside the focus.

If the rule cannot be judged from the selected focus plus bounded context:

- improve the deterministic selector or context
- split the concern into smaller rules
- use a different deterministic tool when the missing relationship is mechanically discoverable
- leave the concern outside jevcheck when a bounded judgement cannot be made reliably

Do not add an applicability or confidence model call merely to compensate for weak candidate construction. Jevcheck's useful contract is one bounded Noul decision where YES consistently means "violation present".

Treat model-visible source as data that may be sent to the configured remote provider. Do not deliberately include secrets, credentials, private keys, environment files, generated output, vendored code, or unrelated proprietary content.

## Stop rule

Evidence is for deciding whether a rule is trustworthy, not for optimizing a score.

Once the boundary is clear, valid and invalid examples separate cleanly enough, required evidence is current, and further changes would mainly increase context, complexity, or policy leniency, stop. If the rule only becomes "good" after broadening the question, inflating context, moving thresholds to fit examples, or weakening graduation requirements, reconsider the rule instead.

## AST-aware narrowing

Use `ast` when a candidate can be identified structurally. Supported selectors are:

~~~json
{ "pattern": "console.log($A)" }
{ "kind": "call_expression" }
{ "rule": { "kind": "call_expression" } }
~~~

JavaScript, TypeScript, TSX, HTML, and CSS are supported by the bundled parser. Common extensions infer the language automatically. `context.ancestor` can include the nearest related ancestor while preserving the original matched node as the exact focus.

Do not turn a deterministic structural condition into a Jev question. If ast-grep alone proves the violation, use ast-grep or an ordinary linter directly instead of jevcheck.

## Inspect before asking

Use provider-free inspection while authoring or debugging a rule:

~~~sh
jevcheck inspect --rule security/no-sensitive-log src/example.ts
jevcheck inspect --changed --base origin/main
jevcheck inspect --staged --format json
~~~

Inspection runs the same deterministic candidate construction and semantic-request construction as a real check, but does not call Jev. Verify:

- the candidate was selected for the intended deterministic reason
- the focus range is exactly what YES/NO applies to
- surrounding context is sufficient but not broader than necessary
- the exact state/question payload contains no unintended source
- the semantic key changes when model-visible semantics change

Fix selection/context before calibrating if the evidence envelope is wrong.

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

Drift compares probabilities only when the exact semantic request hashes, configured threshold, and resolved model are unchanged. If the fixture/rule/context, threshold, or resolved model changed, jevcheck reports the calibration as `STALE`; re-record and requalify it instead of mixing a changed decision surface with ordinary model drift. Significant drift, stale calibration, and added/removed fixtures fail `test --drift` so CI cannot silently ignore changed evidence.

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

The probe keeps the selected source and semantic focus unchanged and adds deterministic untrusted surrounding context to the semantic request. It currently tests direct instruction injection, false approval/authority claims, and unrelated nearby context. Inspect both probability movement and classification flips.

Robustness complements mutation recall:
- mutation recall asks whether meaningful semantic changes are detected
- robustness asks whether label-preserving changes are ignored

The result is persisted in `.jevcheck/evidence.json` with a freshness identity only when every expected fixture/perturbation case was measured. Incomplete runs surface diagnostics and do not overwrite durable evidence. It is advisory rather than a graduation blocker: a flip should be investigated, but do not weaken the rule or threshold merely to make the probe green.

## Confirm on untouched fixtures

Keep confirmation evidence separate from the fixtures used during authoring and threshold selection:

~~~json
{
  "fixtures": {
    "valid": ["fixtures/rule/valid/**/*.ts"],
    "invalid": ["fixtures/rule/invalid/**/*.ts"],
    "confirmation": {
      "valid": ["fixtures/rule/confirmation/valid/**/*.ts"],
      "invalid": ["fixtures/rule/confirmation/invalid/**/*.ts"]
    }
  }
}
~~~

Freeze the rule and threshold, then run:

~~~sh
jevcheck test --confirm
~~~

When confirmation fixtures are configured, they are a graduation gate. Successful results are recorded in `.jevcheck/confirmation.json`; changed confirmation code, rule semantics, or thresholds make that evidence stale.

Confirmation is not a tuning set. If you inspect a failed confirmation result and change the rule because of it, treat that case as development evidence and replace it with fresh confirmation cases before claiming an untouched confirmation.

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
- configured confirmation evidence, including missing/stale/failing untouched cases
- drift evidence
- mutation recall, including unmeasured or zero-judged mutants
- rule source/provenance, including local policy-source freshness

Current fixture semantic identities are recomputed deterministically. Drift and full-scope recall measurements are persisted in `.jevcheck/evidence.json` with freshness identities. Mutation identities also bind the recorded per-mutant outcomes, so partial or inconsistent artifact edits fail closed.

For local provenance such as `docs/security.md#logging`, jevcheck also fingerprints the referenced file. A changed or missing policy source makes persisted evidence stale and blocks an owned rule until the rule/policy relationship is reviewed and evidence is refreshed. The fragment is a human provenance pointer; jevcheck conservatively hashes the whole local file. HTTP(S) provenance is accepted but cannot be freshness-verified offline.

If rule semantics, calibration, relevant mutation inputs, sample size, provider/model identity, recorded outcomes, or local policy source content change without a fresh measurement, expect the audit to report stale evidence rather than silently reuse it.

Treat these hashes as freshness/integrity checks, not cryptographic signatures. Config and committed evidence live inside the same repository trust boundary.

The audit is advisory, but normal checks and replay enforce the same blockers for `owned` rules. Status is never rewritten automatically.

## Graduate a rule to owned

Keep new rules in `shadow` while evidence is being built:

~~~sh
jevcheck test --record
jevcheck test --drift
jevcheck test --robustness
jevcheck recall
jevcheck test --confirm
jevcheck rules audit
~~~

Only change `status` to `owned` when audit reports `Ready for owned: yes`. Normal checks and replay fail closed if an owned rule's required evidence is missing, stale, or failing. Robustness warnings are deliberately advisory and therefore do not change `Ready for owned` yet.

Default policy requires valid and invalid development fixtures, current calibration, no thin margins, clean drift, mutants with at least 0.90 recall and non-zero judged samples, and `source` provenance. If a rule configures confirmation fixtures, current passing confirmation evidence is additionally required. Global `graduation` config can adjust the existing development-evidence requirements; do not weaken them merely to make CI pass.

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
jevcheck inspect --changed --base origin/main
jevcheck test
jevcheck test --record
jevcheck test --drift
jevcheck test --confirm
jevcheck recall
jevcheck coverage record
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

## Stop rule

Stop refining a rule when its bounded meaning is clear, representative valid and invalid cases are covered, current evidence is healthy, and another change would mainly optimize the measured signal rather than improve the rule.

Do not:

- widen context simply to move probabilities
- tune a threshold merely to make fixtures pass when labelled ranges overlap
- weaken graduation policy to make an owned rule admissible
- add speculative exclusions or suppressions just to improve measured results
- record stale or unreviewed deterministic coverage merely to suppress model calls
- broaden an atomic semantic question into a general quality judgement

If a rule needs repeated exceptions, very broad context, or unstable threshold tuning to work, split it into narrower rules, redesign its deterministic candidate selection, or leave it in shadow instead of forcing graduation.
