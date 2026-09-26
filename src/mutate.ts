import { createHash } from "node:crypto";
import { compilePattern } from "./candidates.js";
import type { RuleMutant } from "./types.js";

export function applyMutation(source: string, mutant: RuleMutant): string | undefined {
  const pattern = compilePattern(mutant.pattern, mutant.replaceAll ?? false);
  if (!pattern.test(source)) return undefined;
  pattern.lastIndex = 0;
  const mutated = source.replace(pattern, mutant.replacement);
  return mutated === source ? undefined : mutated;
}

export function stableMutationOrder(ruleId: string, mutantId: string, path: string): string {
  return createHash("sha256")
    .update(ruleId)
    .update("\0")
    .update(mutantId)
    .update("\0")
    .update(path.replaceAll("\\", "/"))
    .digest("hex");
}
