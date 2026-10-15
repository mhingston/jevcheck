import { extname } from "node:path";
import csharp from "@ast-grep/lang-csharp";
import { Lang, registerDynamicLanguage, type DynamicLangRegistrations } from "@ast-grep/napi";

interface LanguageDefinition {
  parser: Lang | string;
  extensions: readonly string[];
  dynamic?: DynamicLangRegistrations[string];
}

// Single source of truth for config names, parsers and extension inference.
const LANGUAGES = {
  javascript: { parser: Lang.JavaScript, extensions: [".js", ".mjs", ".cjs"] },
  typescript: { parser: Lang.TypeScript, extensions: [".ts", ".mts", ".cts"] },
  tsx: { parser: Lang.Tsx, extensions: [".tsx", ".jsx"] },
  html: { parser: Lang.Html, extensions: [".html", ".htm"] },
  css: { parser: Lang.Css, extensions: [".css"] },
  csharp: { parser: "csharp", extensions: [".cs"], dynamic: csharp },
} satisfies Record<string, LanguageDefinition>;

export type AstLanguage = keyof typeof LANGUAGES;
export const AST_LANGUAGES: readonly AstLanguage[] = Object.keys(LANGUAGES) as AstLanguage[];

export function isAstLanguage(value: unknown): value is AstLanguage {
  return typeof value === "string" && Object.hasOwn(LANGUAGES, value);
}

export function inferredAstLanguage(path: string): AstLanguage | undefined {
  const extension = extname(path).toLowerCase();
  return AST_LANGUAGES.find((name) => LANGUAGES[name].extensions.some((entry) => entry === extension));
}

// NAPI supports one registration call per process, so register all packs together.
let registered = false;
let registrationError: Error | undefined;
function registerNativeParsers(): void {
  if (registrationError) throw registrationError;
  if (registered) return;
  const languages: DynamicLangRegistrations = {};
  for (const name of AST_LANGUAGES) {
    const definition: LanguageDefinition = LANGUAGES[name];
    if (definition.dynamic) languages[name] = definition.dynamic;
  }
  try {
    if (Object.keys(languages).length) registerDynamicLanguage(languages);
    registered = true;
  } catch (error) {
    registrationError = new Error(
      "Cannot load the C# AST parser (@ast-grep/lang-csharp). " +
      "Install dependencies with lifecycle scripts enabled (npm ci, not --ignore-scripts; " +
      "with pnpm 10 use --allow-build=@ast-grep/lang-csharp). " +
      "Ensure a native prebuild exists for your OS/architecture or install tree-sitter-cli to build it. " +
      "Original error: " + (error instanceof Error ? error.message : String(error)),
    );
    throw registrationError;
  }
}
export function parserForAstLanguage(language: AstLanguage): Lang | string {
  const definition: LanguageDefinition = LANGUAGES[language];
  if (definition.dynamic) registerNativeParsers();
  return definition.parser;
}
