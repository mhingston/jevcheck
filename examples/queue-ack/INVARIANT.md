# Queue acknowledgement invariant

**An HTTP handler must not acknowledge a job as accepted until queue publication has succeeded.**

In this example a `202 Accepted` response means that the job has been published to the queue, not that downstream processing finished. If publication rejects, the handler must propagate failure, return an appropriate non-2xx response, or complete a real recovery before acknowledging acceptance. Logging a failure is not recovery.

**Applicability:** local TypeScript job-submission handlers that call `queue.publish`. This is scoped by files, a function-declaration AST selector, and a prefilter. No model is asked to discover where the invariant applies.

**Evidence required:** the bounded handler must show both the publication failure path and the value/status returned to the caller. If implementation is in an opaque helper, or runtime behaviour depends on other functions, this rule is insufficient without more deterministic context.

**Static-analysis alternative:** a bespoke control-flow check or integration test could enforce this exactly in some codebases. Prefer that when available; this example demonstrates where a semantic rule *might* help with varied control-flow and response idioms, not a unique capability of Jev.

**Ownership:** starts `shadow`. The valid/invalid files are teaching fixtures, not validation of any provider. Do not promote this rule to `owned` before measuring on representative labelled code, inspecting false positives/negatives, and satisfying the evidence gate.
