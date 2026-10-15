# Rule lifecycle and evidence

Start with [the runnable example](../examples/queue-ack/README.md); use this guide when a shadow rule might become blocking.
## A practical rule lifecycle

A useful default workflow is:

~~~text
author -> inspect -> shadow -> development fixtures -> calibrate -> drift/recall/robustness -> confirm -> audit -> owned
~~~

You do not need all of this to experiment with a shadow rule. The evidence workflow matters when you want a semantic lint rule to become blocking in CI or review.

### 1. Inspect the evidence envelope

Use `jevcheck inspect` while shaping a rule to verify the exact focus, bounded context, question, criteria, semantic fingerprint, and model-visible source before spending a provider call.

~~~sh
npx jevcheck inspect --rule reliability/unbounded-retry src/client.ts
npx jevcheck inspect --changed --base origin/main --format json
~~~

If the preview contains unrelated code or lacks evidence needed for a defensible YES/NO judgement, fix deterministic selection or bounded context first.

### 2. Start in shadow

~~~json
{
  "id": "reliability/unbounded-retry",
  "status": "shadow",
  "question": "Can this retry path continue without a meaningful bound?"
}
~~~

Run it against real changes and inspect where it is right or wrong.

### 3. Add labelled fixtures

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

### 4. Record calibration

When the fixtures pass:

~~~sh
npx jevcheck test --record
~~~

This records the current fixture probabilities in `.jevcheck/calibration.json`.

Later, re-ask those fixtures and compare the probabilities:

~~~sh
npx jevcheck test --drift
~~~

Drift checks intentionally bypass the normal answer cache. If the resolved model changes, the prior calibration is treated as stale and must be requalified rather than reported as ordinary probability drift.

### 5. Measure mutation recall

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

### 6. Probe semantic robustness

Fixtures and mutation recall test whether a rule catches the right semantic changes. Robustness probes the opposite failure mode: whether model-visible text that should be irrelevant can change the judgement.

~~~sh
npx jevcheck test --robustness
~~~

The command keeps the selected source and semantic focus unchanged, then re-runs the same judgement with deterministic untrusted surrounding context under three conditions:

- a direct instruction to ignore the rule
- a false claim that the code was already approved
- unrelated nearby context

It reports probability movement and classification flips, and records freshness-aware results in `.jevcheck/evidence.json` only when every expected fixture/perturbation case was measured. Incomplete runs surface diagnostics and do not overwrite durable evidence. Robustness is intentionally advisory for now: flips appear as audit warnings rather than silently changing graduation policy.

### 7. Confirm on untouched fixtures

Keep a small confirmation set separate from the fixtures used to author the rule or choose its threshold:

~~~json
{
  "fixtures": {
    "valid": ["fixtures/unbounded-retry/valid/**/*.ts"],
    "invalid": ["fixtures/unbounded-retry/invalid/**/*.ts"],
    "confirmation": {
      "valid": ["fixtures/unbounded-retry/confirmation/valid/**/*.ts"],
      "invalid": ["fixtures/unbounded-retry/confirmation/invalid/**/*.ts"]
    }
  }
}
~~~

After the rule, threshold, and development evidence are frozen, run:

~~~sh
npx jevcheck test --confirm
~~~

A configured confirmation set becomes a graduation gate: both valid and invalid cases must exist, remain semantically current, and pass. Successful confirmation is recorded separately in `.jevcheck/confirmation.json`.

Do not tune against confirmation failures and then call the same cases untouched. Once you inspect a failed confirmation result, treat those cases as development evidence and replace them with fresh confirmation cases before the next graduation attempt.

### 8. Audit the evidence

~~~sh
npx jevcheck rules audit
~~~

The audit reports whether each rule has the evidence required to act as an owned rule and explains any blockers. It also shows advisory threshold-separation diagnostics from current labelled calibration and persisted robustness results. If confirmation fixtures are configured, missing, stale, or failing confirmation evidence blocks graduation. If valid and invalid development fixture probabilities overlap, the audit says explicitly that no single threshold can separate the labelled fixtures rather than encouraging threshold tuning.

### 9. Promote to owned

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
| `.jevcheck/calibration.json` | Recorded development-fixture probabilities | For evidence-gated rules |
| `.jevcheck/confirmation.json` | Untouched confirmation-fixture results | When confirmation fixtures are configured |
| `.jevcheck/evidence.json` | Drift, mutation, robustness, and deterministic coverage evidence | For evidence-gated or `coveredBy` rules |
| `.jevcheck/cache.json` | Local answer cache | No |

These evidence files contain hashes and evaluation metadata rather than a second copy of your source code or prompts.

## Evidence and owned-rule graduation

The default graduation policy requires:

- at least one valid and invalid fixture
- current passing calibration
- no thin fixture margins
- clean current drift evidence
- configured and measured mutants
- minimum mutation recall of 0.90
- no zero-judged mutants
- rule `source` provenance; local source files are resolved and fingerprinted

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
# when coveredBy is configured and its deterministic enforcement was reviewed:
npx jevcheck coverage record
npx jevcheck rules audit

# after the audit is ready:
# change status from "shadow" to "owned"

npx jevcheck
~~~

Changing only `status` does not make semantic evidence stale. Changes to the semantic request, threshold, candidate semantics, relevant mutation inputs, calibration, provider/model identity, or the contents of a referenced local policy source can make persisted evidence stale.

For a local source such as `docs/security.md#logging`, jevcheck fingerprints the referenced file content together with the source reference. If that file changes or disappears, persisted rule evidence becomes stale and an owned rule fails closed until its evidence is reviewed and refreshed. The fragment is provenance for humans; freshness currently hashes the whole referenced file conservatively. HTTP(S) sources remain valid provenance but cannot be freshness-verified offline.
