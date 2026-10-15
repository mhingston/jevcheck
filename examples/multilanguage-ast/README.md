# Cross-language AST selector smoke examples

This directory demonstrates **candidate selection only**, not production-grade semantic rules. Four files exercise Python, Go, Java, and Rust grammar packages with the same `emit($VALUE)` pattern. Each rule uses an ancestor selector to make the containing function/method available as bounded context while leaving the call as the focus. The sample code is deliberately small and does **not** constitute a validated secret-leak detection rule.

From this repository's root:

```sh
npm ci
npm run build
node dist/cli.js inspect examples/multilanguage-ast/sources/example.py --config examples/multilanguage-ast/jevcheck.config.json --rule example/python
node dist/cli.js inspect examples/multilanguage-ast/sources/example.go --config examples/multilanguage-ast/jevcheck.config.json --rule example/go
node dist/cli.js inspect examples/multilanguage-ast/sources/example.java --config examples/multilanguage-ast/jevcheck.config.json --rule example/java
node dist/cli.js inspect examples/multilanguage-ast/sources/example.rs --config examples/multilanguage-ast/jevcheck.config.json --rule example/rust
```

All commands are provider-free. Each should emit exactly one inspection with the corresponding language's call node kind and context that contains the Unicode variable `café` and assignment. The accompanying integration tests check patterns, kinds, composite rules, ancestor context, Unicode/CRLF positions, request bounds, invalid selectors, and inspection.

These parsers are native dependencies. Package installation and the five-pack registration are validated in CI on Linux, macOS, and Windows; packages are not guaranteed on every CPU/OS. See [native installation and approved postinstall scripts](../../docs/reference.md#native-parser-installation). For semantic adoption, first establish a real review invariant and labelled fixtures, and run in shadow mode.
