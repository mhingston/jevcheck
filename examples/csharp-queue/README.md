# C# queue acknowledgement: AST-scoped semantic judgement

A handler returning HTTP-style `202 Accepted` after a failed publish can lose work. This example is **production-inspired**, not a real incident or a claim of model accuracy. Both fixtures call `queue.PublishAsync`; the invalid handler catches the failure and then reports success, while the valid handler returns a failure response.

The rule uses `ast.language: "csharp"` (also inferred automatically from `.cs`), matches the call with `pattern`, and includes the containing method using `context.ancestor.kind: "method_declaration"`. It selects a bounded, reviewable method; the model's yes/no judgement remains distinct from AST matching.

From the repository root:

```sh
npm ci
npm run build
node dist/cli.js inspect examples/csharp-queue/src/MessageHandler.cs \
  --config examples/csharp-queue/jevcheck.config.json \
  --rule reliability/no-success-after-publish-failure
```

The output should show a C# `invocation_expression` focus and its containing method, including the `202` return. This command **never contacts a provider** and does not itself assert a violation. For other `.cs` files, use the same rule and change the file path.

C# parsing requires `@ast-grep/lang-csharp`, which is a runtime dependency of jevcheck. Do not use `npm ci --ignore-scripts`: native parser setup needs lifecycle scripts on some platforms. With pnpm 10+, explicitly permit `@ast-grep/lang-csharp` postinstall (e.g. `pnpm add --allow-build=@ast-grep/lang-csharp @ast-grep/lang-csharp`). For a platform lacking native prebuilds, `tree-sitter-cli` and build tools may be necessary. See [parser requirements](../../docs/reference.md#ast-language-support-and-native-parsers).

`jevcheck test` optionally uses the configured provider to evaluate the labelled `fixtures/valid` and `fixtures/invalid` files; never interpret offline inspect as evidence of semantic correctness.
