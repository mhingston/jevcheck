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

JSON config shorthands are normalised to canonical AST selectors and regex prefilters **before** fingerprinting and evidence persistence. The TypeScript `createJevCheck` API continues to accept canonical AST objects and regex prefilters.

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

For normal checks, owned error findings **and incomplete evaluations of applicable owned/error rules** fail enforcement. A genuine rule with no matching candidates remains successful. Incomplete evaluation means applicable content could not be judged because of an unsupported AST language or a `chunkChars` bound. Shadow rules, owned warning rules, and measurement commands report advisory warnings instead. JSON diagnostics expose `code: "incomplete-evaluation"`; SARIF includes the diagnostic and marks execution unsuccessful for blocking incompleteness. Oversized semantic requests are never sent.

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

| `ast.language` | File extension(s) | Parser | Version |
| --- | --- | --- | --- |
| `javascript`, `typescript`, `tsx`, `html`, `css` | `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `.tsx`, `.jsx`, `.html`, `.htm`, `.css` | Built into `@ast-grep/napi` | `^0.45.3` |
| `csharp` | `.cs` | `@ast-grep/lang-csharp` | `0.0.6` |
| `python` | `.py` | `@ast-grep/lang-python` | `0.0.6` |
| `go` | `.go` | `@ast-grep/lang-go` | `0.0.6` |
| `java` | `.java` | `@ast-grep/lang-java` | `0.0.7` |
| `rust` | `.rs` | `@ast-grep/lang-rust` | `0.0.7` |

Extensions infer the parser automatically, or override with `ast.language`. All supported languages use the same `pattern`, `kind`, composite `rule`, and bounded `ast.context.ancestor` selection. AST matches identify the focus, **not** a violation; nearby context is evidence only. `jevcheck inspect` previews exact requests without a provider.

### Native parser installation

The five dynamic parsers are installed as regular runtime dependencies and **registered together, exactly once**. This means no arbitrary parser/plugin loading, but it also means a missing or incompatible native pack can prevent other dynamic languages from registering. Built-in JS/TS/TSX/HTML/CSS AST matching does not depend on native-pack registration. Errors name the parser whose library cannot load, or list the packages when registration fails.

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
