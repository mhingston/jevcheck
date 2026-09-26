import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  RecordedSemanticDecision,
  SemanticDecisionStore,
} from "./types.js";

export const DEFAULT_REPLAY_FILE = ".jevcheck/replay.json";
export const REPLAY_FORMAT_VERSION = 1;

interface ReplayFile {
  version: number;
  decisions: Record<string, RecordedSemanticDecision>;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function semanticDecisionKey(question: unknown, state: unknown): {
  key: string;
  semanticHash: string;
  stateHash: string;
} {
  const semanticHash = hash(JSON.stringify(question));
  const stateHash = hash(JSON.stringify(state));
  return {
    key: hash(["jevcheck-replay-v1", semanticHash, stateHash].join("\0")),
    semanticHash,
    stateHash,
  };
}

function validateDecision(key: string, value: unknown): RecordedSemanticDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("replay decision " + key + " must be an object");
  }
  const decision = value as Record<string, unknown>;
  for (const field of ["key", "semanticHash", "stateHash", "ruleId", "path", "model"] as const) {
    if (typeof decision[field] !== "string" || !(decision[field] as string).trim()) {
      throw new Error("replay decision " + key + "." + field + " must be a non-empty string");
    }
  }
  if (decision.key !== key) throw new Error("replay decision key does not match its map key: " + key);
  if (typeof decision.probability !== "number" || decision.probability < 0 || decision.probability > 1) {
    throw new Error("replay decision " + key + ".probability must be between 0 and 1");
  }
  for (const field of ["startLine", "endLine"] as const) {
    if (!Number.isInteger(decision[field]) || (decision[field] as number) < 1) {
      throw new Error("replay decision " + key + "." + field + " must be a positive integer");
    }
  }
  for (const field of ["startColumn", "endColumn"] as const) {
    if (
      decision[field] !== undefined &&
      (!Number.isInteger(decision[field]) || (decision[field] as number) < 1)
    ) {
      throw new Error("replay decision " + key + "." + field + " must be a positive integer");
    }
  }
  if (decision.focusKind !== undefined && (typeof decision.focusKind !== "string" || !decision.focusKind.trim())) {
    throw new Error("replay decision " + key + ".focusKind must be a non-empty string");
  }
  return decision as unknown as RecordedSemanticDecision;
}

function parseReplayFile(raw: string): ReplayFile {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("replay file must be an object");
  }
  const file = parsed as Record<string, unknown>;
  if (file.version !== REPLAY_FORMAT_VERSION) {
    throw new Error(
      "unsupported replay format version: " +
      String(file.version) +
      " (expected " +
      REPLAY_FORMAT_VERSION +
      ")",
    );
  }
  if (!file.decisions || typeof file.decisions !== "object" || Array.isArray(file.decisions)) {
    throw new Error("replay file decisions must be an object");
  }
  const decisions: Record<string, RecordedSemanticDecision> = {};
  for (const [key, value] of Object.entries(file.decisions as Record<string, unknown>)) {
    decisions[key] = validateDecision(key, value);
  }
  return { version: REPLAY_FORMAT_VERSION, decisions };
}

export class MemorySemanticDecisionStore implements SemanticDecisionStore {
  private readonly decisions = new Map<string, RecordedSemanticDecision>();

  async get(key: string): Promise<RecordedSemanticDecision | undefined> {
    return this.decisions.get(key);
  }

  async set(value: RecordedSemanticDecision): Promise<void> {
    this.decisions.set(value.key, value);
  }

  async count(): Promise<number> {
    return this.decisions.size;
  }

  async flush(): Promise<void> {}
}

export class DiskSemanticDecisionStore implements SemanticDecisionStore {
  private loaded = false;
  private decisions: Record<string, RecordedSemanticDecision> = {};
  private dirty = false;

  constructor(
    private readonly filePath: string,
    private readonly readOnly = false,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.decisions = parseReplayFile(raw).decisions;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.decisions = {};
        return;
      }
      throw error;
    }
  }

  async get(key: string): Promise<RecordedSemanticDecision | undefined> {
    await this.load();
    return this.decisions[key];
  }

  async set(value: RecordedSemanticDecision): Promise<void> {
    if (this.readOnly) throw new Error("cannot write to a read-only replay store");
    await this.load();
    this.decisions[value.key] = value;
    this.dirty = true;
  }

  async flush(): Promise<void> {
    if (this.readOnly || !this.dirty) return;
    await this.load();
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = this.filePath + ".tmp";
    const file: ReplayFile = {
      version: REPLAY_FORMAT_VERSION,
      decisions: Object.fromEntries(
        Object.entries(this.decisions).sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
    await writeFile(temporary, JSON.stringify(file, null, 2) + "\n", "utf8");
    await rename(temporary, this.filePath);
    this.dirty = false;
  }

  async count(): Promise<number> {
    await this.load();
    return Object.keys(this.decisions).length;
  }
}
