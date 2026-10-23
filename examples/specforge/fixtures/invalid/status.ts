// Unsafe projection: caller can silently promote generated rules.
export function buildRule(candidate: { status?: string }) {
  return { ...candidate, status: candidate.status ?? "shadow" };
}
