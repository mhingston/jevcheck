// Safe projection: caller input cannot control promotion.
export function buildRule(candidate: Record<string, unknown>) {
  if ("status" in candidate) throw new Error("manual promotion required");
  return { ...candidate, status: "shadow" };
}
