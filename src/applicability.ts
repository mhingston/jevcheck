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

// Non-resolving XML reader for declarative MSBuild package references.
// It validates tag nesting and does not expand DTDs or external entities.
function xmlUnescape(text: string): string {
  let result = "";
  let cursor = 0;
  while (cursor < text.length) {
    const amp = text.indexOf("&", cursor);
    if (amp === -1) return result + text.slice(cursor);
    result += text.slice(cursor, amp);
    const end = text.indexOf(";", amp + 1);
    if (end === -1) throw new Error("unclosed XML entity");
    const name = text.slice(amp + 1, end);
    const entities: Record<string, string> = {
      amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
    };
    if (Object.hasOwn(entities, name)) {
      result += entities[name]!;
    } else if (/^#(?:x[0-9a-fA-F]+|[0-9]+)$/.test(name)) {
      const code = name[1] === "x"
        ? Number.parseInt(name.slice(2), 16)
        : Number.parseInt(name.slice(1), 10);
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ||
        (code < 32 && code !== 9 && code !== 10 && code !== 13)) {
        throw new Error("invalid XML character reference");
      }
      result += String.fromCodePoint(code);
    } else {
      throw new Error("unsupported XML entity: &" + name + ";");
    }
    cursor = end + 1;
  }
  return result;
}

function dotnetDependencies(source: string): string[] {
  const names: string[] = [];
  const stack: string[] = [];
  let sawRoot = false;
  let cursor = 0;

  while (cursor < source.length) {
    if (source[cursor] !== "<") {
      const end = source.indexOf("<", cursor);
      const text = source.slice(cursor, end === -1 ? undefined : end);
      if (!stack.length && text.trim()) throw new Error("XML text outside Project element");
      xmlUnescape(text);
      cursor = end === -1 ? source.length : end;
      continue;
    }
    if (source.startsWith("<!--", cursor)) {
      const end = source.indexOf("-->", cursor + 4);
      if (end === -1 || source.slice(cursor + 4, end).includes("--")) {
        throw new Error("malformed XML comment");
      }
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", cursor)) {
      if (!stack.length) throw new Error("CDATA outside Project element");
      const end = source.indexOf("]]>", cursor + 9);
      if (end === -1) throw new Error("unclosed XML CDATA section");
      cursor = end + 3;
      continue;
    }
    if (source.startsWith("<?", cursor)) {
      const end = source.indexOf("?>", cursor + 2);
      if (end === -1) throw new Error("unclosed XML processing instruction");
      cursor = end + 2;
      continue;
    }
    if (source.startsWith("<!", cursor)) {
      throw new Error("DTD and external entities are not supported");
    }
    let end = cursor + 1;
    let quote: string | undefined;
    for (; end < source.length; end += 1) {
      const ch = source[end]!;
      if (quote) {
        if (ch === quote) quote = undefined;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "<") {
        throw new Error("nested < within XML tag");
      } else if (ch === ">") {
        break;
      }
    }
    if (end >= source.length || quote) throw new Error("unclosed XML tag");
    const tag = source.slice(cursor + 1, end).trim();
    cursor = end + 1;

    if (tag.startsWith("/")) {
      const close = /^\/([A-Za-z_:][\w.:-]*)\s*$/.exec(tag);
      if (!close || stack.pop() !== close[1]) throw new Error("mismatched XML end tag: " + tag);
      continue;
    }
    const selfClosing = tag.endsWith("/");
    const bare = selfClosing ? tag.slice(0, -1).trimEnd() : tag;
    const opening = /^([A-Za-z_:][\w.:-]*)([\s\S]*)$/.exec(bare);
    if (!opening) throw new Error("invalid XML opening tag");
    const name = opening[1]!;
    let remaining = opening[2]!;
    const attributes = new Map<string, string>();
    while (remaining.trim()) {
      const attr = /^\s+([A-Za-z_:][\w.:-]*)\s*=\s*(["'])([\s\S]*?)\2/.exec(remaining);
      if (!attr || attr[3]!.includes("<") || attributes.has(attr[1]!)) {
        throw new Error("invalid or duplicate XML attribute on " + name);
      }
      attributes.set(attr[1]!, xmlUnescape(attr[3]!));
      remaining = remaining.slice(attr[0].length);
    }
    if (!sawRoot) {
      if (name !== "Project") throw new Error("XML root must be Project");
      sawRoot = true;
    } else if (stack.length === 0) {
      throw new Error("multiple XML root elements");
    }
    if ((name === "PackageReference" || name === "GlobalPackageReference") &&
      attributes.has("Include")) {
      const dependency = attributes.get("Include")!;
      if (dependency && !/[$%]\(/.test(dependency)) names.push(dependency);
    }
    if (!selfClosing) stack.push(name);
  }
  if (!sawRoot || stack.length) throw new Error("unclosed or missing Project element");
  return names;
}

// Shared Go tokenization handles comments and decoded quoted module paths.
function goTokens(line: string): string[] {
  const tokens: string[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    if (/\s/.test(line[cursor]!)) {
      cursor += 1;
      continue;
    }
    if (line.startsWith("//", cursor)) break;
    if (line.startsWith("=>", cursor)) {
      tokens.push("=>");
      cursor += 2;
      continue;
    }
    const ch = line[cursor]!;
    if (ch === "(" || ch === ")") {
      tokens.push(ch);
      cursor += 1;
      continue;
    }
    if (ch === '"' || ch.charCodeAt(0) === 96) {
      const raw = ch.charCodeAt(0) === 96;
      cursor += 1;
      let value = "";
      let closed = false;
      while (cursor < line.length) {
        const next = line[cursor++]!;
        if (next === ch) {
          closed = true;
          break;
        }
        if (next !== "\\" || raw) {
          value += next;
          continue;
        }
        if (cursor >= line.length) throw new Error("unterminated Go escape");
        const escape = line[cursor++]!;
        const simple: Record<string, string> = {
          a: "\u0007", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t",
          v: "\u000b", "\\": "\\", '"': '"',
        };
        if (Object.hasOwn(simple, escape)) {
          value += simple[escape]!;
        } else if (escape === "x" || escape === "u" || escape === "U") {
          const size = escape === "x" ? 2 : escape === "u" ? 4 : 8;
          const digits = line.slice(cursor, cursor + size);
          if (digits.length !== size || !/^[0-9a-fA-F]+$/.test(digits)) {
            throw new Error("invalid Go hex escape");
          }
          const point = Number.parseInt(digits, 16);
          if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
            throw new Error("invalid Go Unicode escape");
          }
          value += String.fromCodePoint(point);
          cursor += size;
        } else {
          throw new Error("unsupported Go string escape: " + escape);
        }
      }
      if (!closed) throw new Error("unclosed Go quoted string");
      if (cursor < line.length && !/\s/.test(line[cursor]!) &&
        !line.startsWith("//", cursor) && line[cursor] !== ")") {
        throw new Error("unexpected text after Go quoted string");
      }
      tokens.push(value);
      continue;
    }
    const start = cursor;
    while (cursor < line.length && !/\s/.test(line[cursor]!) &&
      !line.startsWith("//", cursor) && !line.startsWith("=>", cursor) &&
      line[cursor] !== "(" && line[cursor] !== ")") cursor += 1;
    if (cursor === start) throw new Error("invalid Go token");
    tokens.push(line.slice(start, cursor));
  }
  return tokens;
}

function goDependencies(source: string): string[] {
  const names: string[] = [];
  const blocks = new Set(["require", "replace", "exclude", "retract", "godebug", "tool"]);
  let activeBlock: string | undefined;
  let sawModule = false;
  for (const [index, original] of source.split(/\r?\n/).entries()) {
    try {
      const tokens = goTokens(original);
      if (!tokens.length) continue;
      if (activeBlock && tokens.length === 1 && tokens[0] === ")") {
        activeBlock = undefined;
        continue;
      }
      if (tokens.length === 2 && tokens[1] === "(" && !activeBlock) {
        if (!blocks.has(tokens[0]!)) throw new Error("unsupported Go directive block: " + tokens[0]);
        activeBlock = tokens[0]!;
        continue;
      }
      const directive = activeBlock ?? tokens[0]!;
      const args = activeBlock ? tokens : tokens.slice(1);
      if (args.includes("(") || args.includes(")") || (!activeBlock && tokens[0] === ")")) {
        throw new Error("invalid Go directive parentheses");
      }

      switch (directive) {
        case "module":
          if (activeBlock || sawModule || args.length !== 1) throw new Error("invalid module directive");
          sawModule = true;
          break;
        case "go":
        case "toolchain":
        case "tool":
          if (args.length !== 1) throw new Error("invalid " + directive + " directive");
          break;
        case "require":
        case "exclude":
          if (args.length !== 2) throw new Error("invalid " + directive + " entry");
          if (directive === "require") names.push(args[0]!);
          break;
        case "replace": {
          const arrow = args.indexOf("=>");
          if (arrow < 1 || arrow > 2 || args.lastIndexOf("=>") !== arrow ||
            args.length - arrow < 2 || args.length - arrow > 3) {
            throw new Error("invalid replace entry");
          }
          break;
        }
        case "retract": {
          const value = args.join(" ");
          if (!/^\S+$/.test(value) && !/^\[[^\s,]+,\s*[^\s,]+\]$/.test(value)) {
            throw new Error("invalid retract entry");
          }
          break;
        }
        case "godebug":
          if (args.length !== 1 || !/^[^=\s]+=[^\s]+$/.test(args[0]!)) {
            throw new Error("invalid godebug directive");
          }
          break;
        default:
          throw new Error("unsupported Go directive: " + directive);
      }
    } catch (error) {
      throw new Error("line " + (index + 1) + ": " +
        (error instanceof Error ? error.message : String(error)));
    }
  }
  if (activeBlock) throw new Error("unclosed " + activeBlock + " block");
  if (!sawModule) throw new Error("missing module directive");
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
