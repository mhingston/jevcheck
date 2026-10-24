// Demonstration-only source: inspect selects this candidate without calling a model.
export async function handle(queue: { publish(): Promise<void> }): Promise<number> {
  try {
    await queue.publish();
  } catch {
    console.warn("publish failed");
  }
  return 202;
}
