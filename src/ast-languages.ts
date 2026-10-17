import { createRequire } from "node:module";
import { extname } from "node:path";
import { Lang, registerDynamicLanguage, type DynamicLangRegistrations } from "@ast-grep/napi";

interface LanguageDefinition {
  parser: Lang | string;
  extensions: readonly string[];
  packageName?: string;
}

// Explicit supported languages only; external package availability is not plugin discovery.
// This registry owns configuration names, extension inference, and native parser metadata.
const LANGUAGES = {
  javascript: { parser: Lang.JavaScript, extensions: [".js", ".mjs", ".cjs"] },
  typescript: { parser: Lang.TypeScript, extensions: [".ts", ".mts", ".cts"] },
  tsx: { parser: Lang.Tsx, extensions: [".tsx", ".jsx"] },
  html: { parser: Lang.Html, extensions: [".html", ".htm"] },
  css: { parser: Lang.Css, extensions: [".css"] },
  csharp: { parser: "csharp", extensions: [".cs"], packageName: "@ast-grep/lang-csharp" },
  python: { parser: "python", extensions: [".py"], packageName: "@ast-grep/lang-python" },
  go: { parser: "go", extensions: [".go"], packageName: "@ast-grep/lang-go" },
  java: { parser: "java", extensions: [".java"], packageName: "@ast-grep/lang-java" },
  rust: { parser: "rust", extensions: [".rs"], packageName: "@ast-grep/lang-rust" },
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

export class NativeAstParserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeAstParserError";
  }
}

function actionableNativeParserError(stage: string, packages: string[], error: unknown): NativeAstParserError {
  return new NativeAstParserError(
    "Cannot " + stage + " AST parser(s): " + packages.join(", ") + ". " +
    "Platform: " + process.platform + "/" + process.arch + ". " +
    "Install native parser packages with lifecycle scripts enabled (npm ci, not --ignore-scripts); " +
    "approve their install scripts under npm allowScripts or pnpm 10 --allow-build. " +
    "If a prebuild is unavailable for your OS/architecture, install tree-sitter-cli and native build tools. " +
    "Original error: " + (error instanceof Error ? error.message : String(error)),
  );
}

const requireParser = createRequire(import.meta.url);

// The @ast-grep/lang-* packages export CommonJS registration objects with lazy
// libraryPath getters. Avoid eager ESM imports: a missing package must not stop
// even built-in AST languages from loading.
function loadNativeParser(packageName: string): DynamicLangRegistrations[string] {
  return requireParser(packageName) as DynamicLangRegistrations[string];
}

function materializeParser(
  load: (packageName: string) => DynamicLangRegistrations[string],
  packageName: string,
): DynamicLangRegistrations[string] {
  const parser = load(packageName);
  // Force getters while errors can still be attributed to one package.
  const libraryPath = parser.libraryPath;
  const extensions = parser.extensions;
  if (typeof libraryPath !== "string" || libraryPath.length === 0 || !Array.isArray(extensions)) {
    throw new Error("Invalid native parser registration metadata");
  }
  return {
    libraryPath,
    extensions,
    ...(parser.languageSymbol ? { languageSymbol: parser.languageSymbol } : {}),
    ...(parser.metaVarChar ? { metaVarChar: parser.metaVarChar } : {}),
    ...(parser.expandoChar ? { expandoChar: parser.expandoChar } : {}),
  };
}

/**
 * NAPI supports ONE registration call per process; subsequent calls may be ignored.
 * Collect all loadable packages before that call, retaining language-scoped
 * failures for missing packages or broken metadata. Native dlopen failures
 * during the batch itself cannot safely be isolated using this API.
 *
 * The injected boundaries make the one-shot and fault-isolation contract testable
 * without changing process-global NAPI state.
 */
export function createAstLanguageResolver(
  load: (packageName: string) => DynamicLangRegistrations[string] = loadNativeParser,
  register: (parsers: DynamicLangRegistrations) => void = registerDynamicLanguage,
): (language: AstLanguage) => Lang | string {
  let initialized = false;
  let batchError: NativeAstParserError | undefined;
  const loadingErrors = new Map<AstLanguage, NativeAstParserError>();

  function initialize(): void {
    if (initialized) return;
    initialized = true;
    const parsers: DynamicLangRegistrations = {};
    const packageNames: string[] = [];

    for (const language of AST_LANGUAGES) {
      const definition: LanguageDefinition = LANGUAGES[language];
      if (!definition.packageName) continue;
      try {
        parsers[language] = materializeParser(load, definition.packageName);
        packageNames.push(definition.packageName);
      } catch (error) {
        loadingErrors.set(language, actionableNativeParserError("load", [definition.packageName], error));
      }
    }

    if (!packageNames.length) return;
    try {
      register(parsers);
    } catch (error) {
      // NAPI cannot tell us which of the loadable packages failed during
      // native registration. All attempted languages are affected.
      batchError = actionableNativeParserError("register native", packageNames, error);
    }
  }

  return (language: AstLanguage): Lang | string => {
    const definition: LanguageDefinition = LANGUAGES[language];
    if (definition.packageName) {
      initialize();
      const loadingError = loadingErrors.get(language);
      if (loadingError) throw loadingError;
      if (batchError) throw batchError;
    }
    return definition.parser;
  };
}

export const parserForAstLanguage = createAstLanguageResolver();
