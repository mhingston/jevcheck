# Walkthrough: a false-positive queue acknowledgement

This **production-inspired, deliberately constructed** bug is common in asynchronous HTTP APIs: a handler responds with `202 Accepted` after `queue.publish` rejects because the exception is logged and swallowed. These files illustrate a use case; **no production incident or live model accuracy is claimed**.

The rule checks a behavioural invariant, not an AST shape. `ast.kind=function_declaration` selects one bounded handler; the deterministic `queue.publish` prefilter removes unrelated functions. Jev only judges whether publication failure can reach a success response.

## 1. Inspect the candidate (offline; no API key)

From the **repository root**, with Node.js 20+:

~~~sh
npm ci
npm run build
node dist/cli.js inspect examples/queue-ack/src/handler.ts \
  --config examples/queue-ack/jevcheck.config.json \
  --rule reliability/no-success-after-publish-failure \
  --verbose
~~~

With `--verbose`, you should see one inspected candidate at the `acceptJob` function, its file/line focus, the configured question and criteria, and the exact model-visible code. Without `--verbose`, human output shows policy and candidate counts only; `--format json` puts full request details in `data.inspections[]`. This is a deterministic preview. It **does not** classify the code or assert that Jev will find a violation.

Look for these facts in the preview:

1. `queue.publish(job)` can reject.
2. `catch` logs but does not return an error, throw, or retry.
3. The same successful `202` response is returned after the catch.

If those facts cannot fit inside the candidate, a semantic judgement is not defensible.

## 2. Compare the safe and unsafe cases

- [Unsafe source](src/handler.ts) — swallows a rejected publication.
- [Safe fixture](fixtures/valid/rejects-with-503.ts) — failure returns HTTP 503 and cannot fall through to 202.
- [Unsafe fixture](fixtures/invalid/logs-then-accepts.ts) — different syntax, same bug.
- [Rule configuration](jevcheck.config.json) and [invariant](INVARIANT.md).

You can inspect any one of the files using the same command, replacing the source path. The sample files are self-contained and deliberately dependency-free. The configuration and fixtures are committed as documentation, not as proof of model performance.

## 3. Run a semantic check (optional)

Configure a supported Jev provider before running a model. For example:

~~~sh
export TYPESAFE_API_KEY="..."
node dist/cli.js examples/queue-ack/src/handler.ts \
  --config examples/queue-ack/jevcheck.config.json
~~~

Or use `OPENROUTER_API_KEY` and `JEV_PROVIDER=openrouter`. The rule is `shadow`: findings are advisory and do not fail the build.

If a live provider is available, compare its output with the known failure path and inspect any disagreement. Output probabilities are model-dependent; we intentionally do not provide fabricated results.

Then evaluate the labelled cases:

~~~sh
node dist/cli.js test --config examples/queue-ack/jevcheck.config.json
~~~

A successful fixture run on a small sample is **not** enough to make the rule blocking. Collect independent examples from the target repository and follow [rule lifecycle and evidence](../../docs/rule-lifecycle.md) before considering `owned`.

## Why not just a normal linter?

A simple rule banning `catch` or `return 202` is incorrect: both are valid on many paths. The intended rule asks about the connection between failure handling and the response, which can be expressed in different idioms. In projects where a deterministic control-flow checker, contract test, or other exact enforcement is feasible, use that instead. Do not expand the context beyond the handler merely to make the example work.

## Make this your own

Start from **a judgement your reviewers have already made**. Write its positive and negative boundaries, identify the smallest deterministic candidate that contains all relevant evidence, use `inspect` before sending code, and keep the rule in `shadow` until labelled evaluation demonstrates it is dependable.
