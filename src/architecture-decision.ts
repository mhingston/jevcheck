/**
 * Opt-in, deliberately minimal frontmatter metadata for local ADR sources.
 * This is not a YAML parser or a semantic interpretation of ADR prose.
 */
export interface ArchitectureDecision {
  status: string;
  active: boolean;
  detail: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function parseArchitectureDecision(content: string): ArchitectureDecision | undefined {
  const frontmatter = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!frontmatter) {
    // A malformed opt-in must not fall back to ordinary, unchecked provenance.
    // Only inspect the initial run of metadata lines after the opening delimiter:
    // prose and code examples later in a document do not count as opt-in.
    const opening = /^(?:\uFEFF)?---\r?\n/.exec(content);
    if (!opening) return undefined;
    const lines = content.slice(opening[0].length).split(/\r?\n/);
    for (const line of lines) {
      const field = /^([a-z][a-z0-9-]*):[ \t]*(.*?)[ \t]*$/i.exec(line);
      if (!field) break;
      if (field[1]!.toLowerCase() === "jevcheck-adr" && unquote(field[2]!).toLowerCase() === "true") {
        return {
          status: "invalid",
          active: false,
          detail: "ADR metadata has no closing frontmatter delimiter",
        };
      }
    }
    return undefined;
  }

  const fields = new Map<string, string[]>();
  for (const line of frontmatter[1]!.split(/\r?\n/)) {
    const match = /^([a-z][a-z0-9-]*):[ \t]*(.*?)[ \t]*$/i.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const values = fields.get(key) ?? [];
    values.push(unquote(match[2]!));
    fields.set(key, values);
  }

  const markers = fields.get("jevcheck-adr");
  if (!markers?.some((value) => value.toLowerCase() === "true")) return undefined;
  if (markers.length !== 1) {
    return {
      status: "invalid",
      active: false,
      detail: "ADR metadata has an invalid jevcheck-adr marker (expected true)",
    };
  }

  const statuses = fields.get("status");
  if (!statuses || statuses.length !== 1 || !statuses[0]) {
    return {
      status: "invalid",
      active: false,
      detail: "ADR metadata must declare exactly one non-empty status",
    };
  }

  const status = statuses[0].toLowerCase();
  const successors = fields.get("superseded-by") ?? [];
  if (successors.length > 1) {
    return {
      status: "invalid",
      active: false,
      detail: "ADR metadata declares superseded-by more than once",
    };
  }
  const successor = successors[0];
  if (status === "accepted" && successor) {
    return {
      status,
      active: false,
      detail: "ADR status accepted conflicts with superseded-by " + successor,
    };
  }

  const known = ["accepted", "proposed", "superseded", "withdrawn", "rejected", "deprecated"];
  if (!known.includes(status)) {
    return {
      status,
      active: false,
      detail: "Unknown ADR status " + status + " (only accepted is enforceable)",
    };
  }
  return {
    status,
    active: status === "accepted",
    detail:
      "ADR status " +
      status +
      (successor ? "; superseded by " + successor : "") +
      (status === "accepted" ? " (active)" : " (not authoritative)"),
  };
}
