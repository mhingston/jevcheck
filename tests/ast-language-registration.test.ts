import { createRequire } from "node:module";
import { Lang, parse, registerDynamicLanguage, type DynamicLangRegistrations } from "@ast-grep/napi";
import { describe, expect, it } from "vitest";
import { createAstLanguageResolver, NativeAstParserError } from "../src/ast-languages.js";

function registration(name: string): DynamicLangRegistrations[string] {
  return { libraryPath: "/mock/" + name + ".so", extensions: [name], expandoChar: "µ" };
}

describe("dynamic AST parser fault isolation", () => {
  it("keeps load failures language-scoped and registers remaining packs only once", () => {
    const loaded: string[] = [];
    const batches: DynamicLangRegistrations[] = [];
    const resolve = createAstLanguageResolver(
      (packageName) => {
        loaded.push(packageName);
        if (packageName === "@ast-grep/lang-go") throw new Error("missing Go native binary");
        return registration(packageName);
      },
      (parsers) => { batches.push(parsers); },
    );

    expect(resolve("typescript")).toBe(Lang.TypeScript);
    expect(loaded).toEqual([]);

    // Even if the first language requested is broken, healthy languages survive.
    expect(() => resolve("go")).toThrow(NativeAstParserError);
    expect(resolve("python")).toBe("python");
    expect(resolve("csharp")).toBe("csharp");
    expect(resolve("rust")).toBe("rust");
    expect(batches).toHaveLength(1);
    expect(Object.keys(batches[0]!)).toEqual(["csharp", "python", "java", "rust"]);
    expect(batches[0]?.python.expandoChar).toBe("µ");
    expect(loaded).toHaveLength(5);
    expect(() => resolve("go")).toThrow(/@ast-grep\/lang-go/);
    expect(() => resolve("go")).toThrow(/missing Go native binary/);
    expect(() => resolve("go")).toThrow(new RegExp(process.platform + "/" + process.arch));
    expect(() => resolve("go")).toThrow(/--allow-build/);
    expect(batches).toHaveLength(1);
  });

  it("isolates native metadata getter failures before batch registration", () => {
    const registered: DynamicLangRegistrations[] = [];
    const resolve = createAstLanguageResolver(
      (packageName) => {
        if (packageName === "@ast-grep/lang-java") {
          return {
            get libraryPath() { throw new Error("No parser found"); },
            extensions: ["java"],
          };
        }
        return registration(packageName);
      },
      (parsers) => { registered.push(parsers); },
    );

    expect(resolve("python")).toBe("python");
    expect(registered).toHaveLength(1);
    expect(registered[0]).not.toHaveProperty("java");
    expect(() => resolve("java")).toThrow(/Cannot load AST parser\(s\): @ast-grep\/lang-java/);
    expect(() => resolve("java")).toThrow(/No parser found/);
    expect(resolve("go")).toBe("go");
  });

  it("does not conceal an unrecoverable batch registration error", () => {
    let attempts = 0;
    const resolve = createAstLanguageResolver(
      (packageName) => registration(packageName),
      () => { attempts += 1; throw new Error("native dlopen failed"); },
    );

    expect(resolve("html")).toBe(Lang.Html);
    expect(() => resolve("python")).toThrow(/Cannot register native AST parser\(s\)/);
    expect(() => resolve("csharp")).toThrow(/native dlopen failed/);
    expect(() => resolve("rust")).toThrow(/@ast-grep\/lang-rust/);
    expect(attempts).toBe(1);
  });

  it("actually parses a working native language when an unrelated package is missing", () => {
    const requireParser = createRequire(import.meta.url);
    const resolve = createAstLanguageResolver(
      (packageName) => {
        if (packageName === "@ast-grep/lang-go") throw new Error("simulated unavailable Go pack");
        return requireParser(packageName) as DynamicLangRegistrations[string];
      },
      registerDynamicLanguage,
    );

    expect(() => resolve("go")).toThrow(/@ast-grep\/lang-go/);
    expect(resolve("python")).toBe("python");
    const root = parse("python", "def run():\n    pass\n").root();
    expect(root.kind()).toBe("module");
    expect(root.findAll({ rule: { kind: "function_definition" } })).toHaveLength(1);
    expect(() => resolve("go")).toThrow(/simulated unavailable Go pack/);
    expect(resolve("python")).toBe("python");
  });
});
