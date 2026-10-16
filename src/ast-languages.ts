import { extname } from "node:path";
import csharp from "@ast-grep/lang-csharp";
import go from "@ast-grep/lang-go";
import java from "@ast-grep/lang-java";
import python from "@ast-grep/lang-python";
import rust from "@ast-grep/lang-rust";
import { Lang, registerDynamicLanguage, type DynamicLangRegistrations } from "@ast-grep/napi";

interface LanguageDefinition {
  parser: Lang | string;
  extensions: readonly string[];
  packageName?: string;
  dynamic?: DynamicLangRegistrations[string];
}

// Explicit supported languages only; external package availability is not plugin discovery.
// This registry owns configuration names, extension inference, and native parser metadata.
const LANGUAGES = {
  javascript: { parser: Lang.JavaScript, extensions: [".js", ".mjs", ".cjs"] },
  typescript: { parser: Lang.TypeScript, extensions: [".ts", ".mts", ".cts"] },
  tsx: { parser: Lang.Tsx, extensions: [".tsx", ".jsx"] },
  html: { parser: Lang.Html, extensions: [".html", ".htm"] },
  css: { parser: Lang.Css, extensions: [".css"] },
  csharp: { parser: "csharp", extensions: [".cs"], packageName: "@ast-grep/lang-csharp", dynamic: csharp },
  python: { parser: "python", extensions: [".py"], packageName: "@ast-grep/lang-python", dynamic: python },
  go: { parser: "go", extensions: [".go"], packageName: "@ast-grep/lang-go", dynamic: go },
  java: { parser: "java", extensions: [".java"], packageName: "@ast-grep/lang-java", dynamic: java },
  rust: { parser: "rust", extensions: [".rs"], packageName: "@ast-grep/lang-rust", dynamic: rust },
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

// @ast-grep/napi registers dynamic languages once per process, in a single batch.
let registered = false;
let registrationError: Error | undefined;

export class NativeAstParserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeAstParserError";
  }
}

function actionableNativeParserError(stage: string, packages: string[], error: unknown): NativeAstParserError {
  return new NativeAstParserError(
    "Cannot " + stage + " AST parser(s): " + packages.join(", ") + ". " +
    "Install native parser packages with lifecycle scripts enabled (npm ci, not --ignore-scripts); " +
    "approve their install scripts under npm allowScripts or pnpm 10 --allow-build. " +
    "If a prebuild is unavailable for your OS/architecture, install tree-sitter-cli and native build tools. " +
    "Original error: " + (error instanceof Error ? error.message : String(error)),
  );
}

function registerNativeParsers(): void {
  if (registrationError) throw registrationError;
  if (registered) return;

  const languages: DynamicLangRegistrations = {};
  const packages: string[] = [];
  for (const name of AST_LANGUAGES) {
    const definition: LanguageDefinition = LANGUAGES[name];
    if (!definition.dynamic) continue;
    // Materialize lazy libraryPath getters separately for specific missing-parser diagnostics.
    try {
      languages[name] = {
        libraryPath: definition.dynamic.libraryPath,
        extensions: definition.dynamic.extensions,
        ...(definition.dynamic.languageSymbol ? { languageSymbol: definition.dynamic.languageSymbol } : {}),
        ...(definition.dynamic.metaVarChar ? { metaVarChar: definition.dynamic.metaVarChar } : {}),
        ...(definition.dynamic.expandoChar ? { expandoChar: definition.dynamic.expandoChar } : {}),
      };
    } catch (error) {
      registrationError = actionableNativeParserError("load", [definition.packageName ?? name], error);
      throw registrationError;
    }
    packages.push(definition.packageName ?? name);
  }

  try {
    if (packages.length) registerDynamicLanguage(languages);
    registered = true;
  } catch (error) {
    registrationError = actionableNativeParserError("register native", packages, error);
    throw registrationError;
  }
}

export function parserForAstLanguage(language: AstLanguage): Lang | string {
  const definition: LanguageDefinition = LANGUAGES[language];
  if (definition.dynamic) registerNativeParsers();
  return definition.parser;
}
