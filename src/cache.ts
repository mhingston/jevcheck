import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AnswerCache, CachedDecision } from "./types.js";

export class MemoryAnswerCache implements AnswerCache {
  private readonly values = new Map<string, CachedDecision>();

  async get(key: string): Promise<CachedDecision | undefined> {
    return this.values.get(key);
  }

  async set(key: string, value: CachedDecision): Promise<void> {
    this.values.set(key, value);
  }
}

export class DiskAnswerCache implements AnswerCache {
  private loaded = false;
  private values: Record<string, CachedDecision> = {};

  constructor(private readonly filePath: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.values = parsed as Record<string, CachedDecision>;
      }
    } catch {
      this.values = {};
    }
  }

  async get(key: string): Promise<CachedDecision | undefined> {
    await this.load();
    return this.values[key];
  }

  async set(key: string, value: CachedDecision): Promise<void> {
    await this.load();
    this.values[key] = value;
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = this.filePath + ".tmp";
    await writeFile(temporary, JSON.stringify(this.values, null, 2) + "\n", "utf8");
    await rename(temporary, this.filePath);
  }
}
