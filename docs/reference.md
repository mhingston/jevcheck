# CLI, configuration and developer reference

For first use see [README](../README.md) and [the executable example](../examples/queue-ack/README.md).
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
| `jevcheck coverage record` | Record reviewed deterministic coverage fingerprints |
| `jevcheck baseline` | Create or refresh accepted-backlog entries |
| `jevcheck record` | Record semantic decisions for replay |
| `jevcheck replay` | Re-run the recorded decisions strictly offline |
| `jevcheck list` | List configured rules without provider credentials |
| `jevcheck inspect` | Preview exact semantic requests without a provider call |

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
| Custom/System One-compatible | `custom` | `JEV_API_KEY` when required |

For a custom System One-compatible API, set `JEV_ENDPOINT` to the endpoint (for example an implementation of the `/v1/systemone` contract). A custom provider has no implicit model default; set `--model` or `JEV_MODEL` only when the endpoint requires one.

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

## AST language support and native parsers

AST candidate selection supports `javascript`, `typescript`, `tsx`, `html`, `css`, and `csharp`. Extension inference covers JS/TS/TSX/HTML/CSS and `.cs`; set `ast.language` to override inference. Pattern, kind and composite rule selectors work in C#; `ast.context.ancestor` expands bounded context, not the focus.

JavaScript-family parsers are built into `@ast-grep/napi`. C# uses `@ast-grep/lang-csharp@0.0.6`. jevcheck registers all enabled native parser packs together, once per process. Arbitrary parser/plugin loading is not supported.

- Use `npm ci` or `npm install` with lifecycle scripts enabled; jevcheck explicitly approves only the pinned `@ast-grep/lang-csharp@0.0.6` postinstall under npm's `allowScripts` policy (npm 11+). `--ignore-scripts` may leave native parser files unprepared.
- For pnpm 10+, permit the postinstall: `pnpm add --allow-build=@ast-grep/lang-csharp @ast-grep/lang-csharp`.
- Native prebuilds are platform-specific. When none is available, install `tree-sitter-cli` and the required native build toolchain.
- Parser errors name the package and repair steps; `inspect` stays provider-free. CI checks native loading on Linux, macOS and Windows.

See the [runnable C# example](../examples/csharp-queue/README.md).
