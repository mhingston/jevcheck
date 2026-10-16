import { lstat, readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { glob } from "tinyglobby";
import type { DependencyCondition, ProjectCondition } from "./types.js";

function projectPath(cwd: string, path: string): string {
  if (isAbsolute(path)) throw new Error("project condition paths must be repository-relative: " + path);
  const root = resolve(cwd);
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw new Error("project condition paths must stay inside the repository: " + path);
  }
  return absolute;
}

function projectPattern(pattern: string): string {
  if (isAbsolute(pattern) || pattern.replaceAll("\\", "/").split("/").includes("..")) {
    throw new Error("project condition globs must stay inside the repository: " + pattern);
  }
  return pattern;
}

const DEPENDENCY_FIELDS = [
  "dependencies", "devDependencies", "peerDependencies", "optionalDependencies",
] as const;

function nodeDependencies(source: string): string[] {
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("package.json must contain an object");
  }
  const manifest = value as Record<string, unknown>;
  const names: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const section = manifest[field];
    if (section === undefined) continue;
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      throw new Error(field + " must be an object");
    }
    names.push(...Object.keys(section));
  }
  return names;
}

// Static declarations only. PackageVersion sets a centrally managed version but
// does not itself add a project dependency; GlobalPackageReference does.
function dotnetDependencies(source: string): string[] {
  if (/<!DOCTYPE\b/i.test(source)) throw new Error("DOCTYPE is not supported");
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, "");
  if (withoutComments.includes("<!--")) throw new Error("unclosed XML comment");
  if (!/<Project(?:\s|>)/.test(withoutComments) || !/<\/Project\s*>/.test(withoutComments)) {
    throw new Error("expected a closed Project element");
  }
  const names: string[] = [];
  const tags = /<(PackageReference|GlobalPackageReference)\b([^<>]*)>/g;
  for (const match of withoutComments.matchAll(tags)) {
    const attributes = match[2]!;
    const include = /(?:^|\s)Include\s*=\s*(["'])(.*?)\1/s.exec(attributes);
    if (include && include[2]) names.push(include[2]);
  }
  return names;
}

function goDependencies(source: string): string[] {
  const names: string[] = [];
  let inRequire = false;
  let hasModule = false;
  for (const original of source.split(/\r?\n/)) {
    const line = original.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    if (/^module\s+\S+/.test(line)) hasModule = true;
    if (inRequire) {
      if (line === ")") {
        inRequire = false;
        continue;
      }
      const entry = /^(\S+)\s+\S+$/.exec(line);
      if (!entry) throw new Error("malformed require entry: " + line);
      names.push(entry[1]!);
      continue;
    }
    if (/^require\s*\($/.test(line)) {
      inRequire = true;
      continue;
    }
    if (/^require\b/.test(line)) {
      const entry = /^require\s+(\S+)\s+\S+$/.exec(line);
      if (!entry) throw new Error("malformed require directive: " + line);
      names.push(entry[1]!);
    }
  }
  if (inRequire) throw new Error("unclosed require block");
  if (!hasModule) throw new Error("missing module directive");
  return names;
}

const MANIFESTS: Record<DependencyCondition["ecosystem"], { root: string[]; workspace: string[] }> = {
  node: { root: ["package.json"], workspace: ["**/package.json"] },
  dotnet: {
    root: ["*.csproj", "Directory.Packages.props"],
    workspace: ["**/*.csproj", "**/Directory.Packages.props"],
  },
  go: { root: ["go.mod"], workspace: ["**/go.mod"] },
};

const IGNORE = [
  "**/.git/**", "**/node_modules/**", "**/vendor/**",
  "**/bin/**", "**/obj/**", "**/target/**", "**/dist/**",
];

async function dependencyManifestNames(ecosystem: DependencyCondition["ecosystem"], source: string): Promise<string[]> {
  if (ecosystem === "node") return nodeDependencies(source);
  if (ecosystem === "dotnet") return dotnetDependencies(source);
  return goDependencies(source);
}

async function hasDependency(cwd: string, condition: DependencyCondition): Promise<boolean> {
  const scope = condition.scope ?? "root";
  const paths = (await glob(MANIFESTS[condition.ecosystem][scope], {
    cwd,
    dot: true,
    expandDirectories: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: IGNORE,
  })).sort();
  let found = false;
  for (const path of paths) {
    try {
      const absolute = projectPath(cwd, path);
      const file = await lstat(absolute);
      if (file.isSymbolicLink()) throw new Error("symbolic-link manifests are not supported");
      if (file.size > 2 * 1024 * 1024) throw new Error("manifest exceeds the 2 MiB limit");
      const source = await readFile(absolute, "utf8");
      const names = await dependencyManifestNames(condition.ecosystem, source);
      // Scan every selected manifest even after a match: a malformed sibling must
      // never be hidden by filesystem iteration order or short-circuiting.
      found ||= names.some((name) => condition.ecosystem === "dotnet"
        ? name.toLowerCase() === condition.name.toLowerCase()
        : name === condition.name);
    } catch (error) {
      throw new Error(
        "invalid " + condition.ecosystem + " dependency manifest " + path + ": " +
        (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  return found;
}

export async function projectConditionMatches(
  condition: ProjectCondition,
  cwd = process.cwd(),
): Promise<boolean> {
  if ("packageJsonHasDep" in condition) {
    return hasDependency(cwd, { ecosystem: "node", name: condition.packageJsonHasDep });
  }
  if ("hasDependency" in condition) {
    return hasDependency(cwd, condition.hasDependency);
  }
  if ("fileExists" in condition) {
    try {
      await stat(projectPath(cwd, condition.fileExists));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  if ("globMatches" in condition) {
    return (await glob(projectPattern(condition.globMatches), {
      cwd,
      dot: true,
      expandDirectories: false,
      onlyFiles: true,
      followSymbolicLinks: false,
    })).length > 0;
  }
  if ("anyOf" in condition) {
    for (const item of condition.anyOf) {
      if (await projectConditionMatches(item, cwd)) return true;
    }
    return false;
  }
  if ("allOf" in condition) {
    for (const item of condition.allOf) {
      if (!(await projectConditionMatches(item, cwd))) return false;
    }
    return true;
  }
  return !(await projectConditionMatches(condition.not, cwd));
}

export function describeProjectCondition(condition: ProjectCondition): string {
  if ("packageJsonHasDep" in condition) return "package.json has dependency " + condition.packageJsonHasDep;
  if ("hasDependency" in condition) {
    const { ecosystem, name, scope = "root" } = condition.hasDependency;
    return ecosystem + " " + scope + " manifests declare dependency " + name;
  }
  if ("fileExists" in condition) return "file exists: " + condition.fileExists;
  if ("globMatches" in condition) return "glob matches: " + condition.globMatches;
  if ("anyOf" in condition) return "any of (" + condition.anyOf.map(describeProjectCondition).join("; ") + ")";
  if ("allOf" in condition) return "all of (" + condition.allOf.map(describeProjectCondition).join("; ") + ")";
  return "not (" + describeProjectCondition(condition.not) + ")";
}
