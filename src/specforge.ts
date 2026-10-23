import { basename, isAbsolute } from "node:path";
import { parseConfig } from "./config.js";

/**
 * Project explicitly reviewed SpecForge invariants into advisory jevcheck rules.
 * Input MUST be the full JSON Graph Protocol export from a successful
 * 'specforge check --strict'; never parse .spec prose as a substitute.
 */
export interface SpecForgeProjection {
  include?: string[];
  rules: Record<string, unknown>[];
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(name + " must be an object");
  }
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(name + " must be a non-empty string");
  }
  return value;
}

function relativeSource(value: unknown, id: string): string {
  const source = nonEmpty(value, id + ".source");
  const parts = source.split("#");
  if (parts.length !== 2 || parts[1] !== id) {
    throw new Error(id + ".source must link to the exact #invariant ID");
  }
  const path = parts[0]!;
  const normalized = path.replaceAll("\\", "/");
  if (isAbsolute(path) || /^[a-zA-Z]:\//.test(normalized) ||
      normalized.startsWith("/") || normalized.split("/").includes("..") ||
      normalized.split("/").includes(".") || !normalized.endsWith(".spec")) {
    throw new Error(id + ".source must name a repository-relative .spec file");
  }
  return source;
}

function schemaVersion(graph: Record<string, unknown>): void {
  if (graph.format_version !== "1.0" && graph.format_version !== "2.0") {
    throw new Error("expected a full SpecForge Graph Protocol export (format_version 1.0 or 2.0)");
  }
  nonEmpty(graph.schema_version, "graph.schema_version");
  if (graph.token_budget !== undefined) {
    throw new Error("budgeted SpecForge graph exports are not accepted");
  }
}

export function projectSpecForge(
  graphValue: unknown,
  mappingValue: unknown,
): SpecForgeProjection {
  const graph = object(graphValue, "graph");
  schemaVersion(graph);
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new Error("graph must contain nodes and edges arrays");
  }

  const nodes = new Map<string, Record<string, unknown>>();
  const behaviors = new Set<string>();
  for (const value of graph.nodes) {
    const node = object(value, "graph node");
    const id = nonEmpty(node.id, "node.id");
    const kind = nonEmpty(node.kind, id + ".kind");
    if (nodes.has(id)) throw new Error("duplicate graph entity: " + id);
    nodes.set(id, node);
    if (kind === "behavior") behaviors.add(id);
  }
  const enforced = new Set<string>();
  for (const value of graph.edges) {
    const edge = object(value, "graph edge");
    if (edge.label === "invariants" && typeof edge.source === "string" &&
        typeof edge.target === "string" && behaviors.has(edge.source)) {
      enforced.add(edge.target);
    }
  }

  const mapping = object(mappingValue, "mapping");
  for (const key of Object.keys(mapping)) {
    if (key !== "include" && key !== "rules") {
      throw new Error("mapping." + key + " is not supported");
    }
  }
  if (!Array.isArray(mapping.rules) || mapping.rules.length === 0) {
    throw new Error("mapping.rules must contain at least one reviewed rule");
  }

  const rules = mapping.rules.map((value, index) => {
    const entry = object(value, "mapping.rules[" + index + "]");
    const id = nonEmpty(entry.invariant, "mapping.rules[" + index + "].invariant");
    const node = nodes.get(id);
    if (!node || node.kind !== "invariant") {
      throw new Error("mapped invariant does not exist: " + id);
    }
    if (!enforced.has(id)) {
      throw new Error("mapped invariant is not enforced by a behavior: " + id);
    }

    const fields = object(node.fields, id + ".fields");
    const guarantee = nonEmpty(fields.guarantee, id + ".guarantee");
    if (entry.expectedGuarantee !== guarantee) {
      throw new Error("guarantee drift for " + id + ": review and update expectedGuarantee");
    }

    const source = relativeSource(entry.source, id);
    const sourcePath = source.slice(0, source.indexOf("#")).replaceAll("\\", "/");
    const nodePath = nonEmpty(node.file, id + ".file").replaceAll("\\", "/");
    if (basename(sourcePath) !== basename(nodePath)) {
      throw new Error("source path differs from SpecForge graph for " + id);
    }

    const { invariant: _invariant, expectedGuarantee: _expectedGuarantee,
      source: _source, ...candidate } = entry;
    if ("status" in candidate || "why" in candidate || "coveredBy" in candidate) {
      throw new Error(id + ": mapping cannot set status, why or coveredBy");
    }
    if (candidate.wholeFile !== true && candidate.ast === undefined &&
        candidate.contains === undefined && candidate.prefilter === undefined) {
      throw new Error(id + ": semantic rule needs a deterministic candidate selector");
    }
    return { ...candidate, why: guarantee, source, status: "shadow" };
  });

  const result: SpecForgeProjection = {
    ...(mapping.include === undefined ? {} : { include: mapping.include as string[] }),
    rules,
  };
  // Reuse jevcheck's complete config validator, including duplicate IDs and AST rules.
  parseConfig(result);
  return result;
}
