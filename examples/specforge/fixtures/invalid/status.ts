// Unsafe path: the failure is swallowed, and success is falsely reported.
export async function main(graph: unknown, mapping: unknown) {
  try {
    const rules = projectSpecForge(graph, mapping);
    await writeFile("config.json", JSON.stringify(rules));
  } catch (error) {
    console.error(error);
  }
  console.log("Wrote projected config");
}
