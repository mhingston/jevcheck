spec "jevcheck-specforge-projection" {
  version "0.1.0"
}

invariant mapped_guarantees_must_match "No silent guarantee drift" {
  guarantee "A mapped invariant MUST match the exact approved guarantee before any rule is emitted."
  risk high
  verify unit "a changed guarantee rejects the projection"
}

invariant projected_rules_stay_advisory "Generated rules are advisory" {
  guarantee "A generated rule MUST remain in shadow status regardless of mapping input."
  risk high
  verify unit "a mapping cannot request owned status or bypass evidence gates"
}

invariant only_enforced_invariants "Only linked invariants are projected" {
  guarantee "An invariant MUST be referenced by a declared behavior before it can be projected."
  risk high
  verify unit "unlinked invariants are rejected"
}

invariant preserve_spec_provenance "Keep stable specification provenance" {
  guarantee "Each projected rule MUST identify its repository-local specification and exact invariant ID."
  risk medium
  verify unit "source paths and invariant references are checked"
}

invariant projection_must_not_ack_failed_validation "No false success on failed projection" {
  guarantee "The CLI MUST NOT report successful projection when validation or output writing fails without successful recovery."
  risk high
  verify unit "failed validation or output writing never reports success"
}

invariant reject_unsafe_provenance_paths "Canonical local provenance only" {
  guarantee "Projected source references MUST reject padded paths, URI schemes, drive-relative paths and traversal forms."
  risk high
  verify unit "unsafe local-source spellings are rejected before fingerprinting"
}

invariant reject_scoped_graph_exports "Full graph required" {
  guarantee "The projector MUST reject scoped SpecForge graph exports, even without a token budget."
  risk high
  verify unit "a graph containing schema_ref is rejected"
}

behavior project_invariants "Project checked specifications into semantic lint rules" {
  category command
  invariants [mapped_guarantees_must_match, projected_rules_stay_advisory, only_enforced_invariants, preserve_spec_provenance, projection_must_not_ack_failed_validation, reject_unsafe_provenance_paths, reject_scoped_graph_exports]
  contract "Given a checked full SpecForge graph and reviewed mapping, generate only advisory jevcheck rules, or fail without producing output."
  verify unit "valid mapping projects one shadow rule"
  verify unit "invalid mappings and stale guarantees fail closed"
}
