// Safe path: validation and writing must succeed before reporting success.
export async function main(graph: unknown, mapping: unknown) {
  const rules = projectSpecForge(graph, mapping);
  await writeFile("config.json", JSON.stringify(rules));
  console.log("Wrote projected config");
}
