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
2. Narrow candidates deterministically with files, exclude, prefilter, and unless.
3. Add true and false criteria when the boundary is easy to confuse.
4. Add both valid and invalid fixtures.
5. Start the rule in shadow status.
6. Inspect false positives, false negatives, probability margins, and model drift before making it owned.
7. Keep thresholds, CI behavior, suppressions, baselines, and other policy in code rather than asking the model to decide them.

## Running

Use the smallest relevant scope:

~~~sh
jevcheck --staged
jevcheck --changed
jevcheck --changed --base origin/main
jevcheck test
jevcheck list
~~~

A shadow finding is advisory. Only an owned error finding is blocking.

Do not treat a high Jev probability as proof. It is a semantic signal that should be evaluated against labelled fixtures and real review outcomes.
