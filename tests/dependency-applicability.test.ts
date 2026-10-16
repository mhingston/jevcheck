import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeProjectCondition, projectConditionMatches } from "../src/applicability.js";
import { parseConfig } from "../src/config.js";
import type { ProjectCondition } from "../src/types.js";

async function fixture(files: Record<string, string>): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "jevcheck-deps-"));
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(cwd, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, content);
  }
  return cwd;
}

const dep = (
  ecosystem: "node" | "dotnet" | "go",
  name: string,
  scope?: "root" | "workspace",
): ProjectCondition => ({ hasDependency: { ecosystem, name, ...(scope ? { scope } : {}) } });

describe("manifest-aware project applicability", () => {
  it("matches Node's declared dependency sections, preserves the legacy predicate, and scopes workspaces", async () => {
    const cwd = await fixture({
      "package.json": JSON.stringify({ dependencies: { express: "^5" }, devDependencies: { vitest: "^3" } }),
      "packages/ui/package.json": JSON.stringify({ peerDependencies: { react: "^19" }, optionalDependencies: { sharp: "^0.33" } }),
      "node_modules/hidden/package.json": JSON.stringify({ dependencies: { excluded: "*" } }),
    });
    expect(await projectConditionMatches(dep("node", "express"), cwd)).toBe(true);
    expect(await projectConditionMatches({ packageJsonHasDep: "express" }, cwd)).toBe(true);
    expect(await projectConditionMatches(dep("node", "react"), cwd)).toBe(false);
    expect(await projectConditionMatches(dep("node", "react", "workspace"), cwd)).toBe(true);
    expect(await projectConditionMatches(dep("node", "sharp", "workspace"), cwd)).toBe(true);
    expect(await projectConditionMatches(dep("node", "excluded", "workspace"), cwd)).toBe(false);
    expect(await projectConditionMatches(dep("node", "constructor"), cwd)).toBe(false);
    expect(await projectConditionMatches(dep("node", "missing"), cwd)).toBe(false);
  });

  it("reads explicit NuGet references and global references but not central package versions or XML comments", async () => {
    const cwd = await fixture({
      "Directory.Packages.props": [
        "<Project>",
        '  <ItemGroup><PackageVersion Include="Serilog" Version="4.0" />',
        '  <GlobalPackageReference Include="Microsoft.SourceLink.GitHub" Version="8.0" /></ItemGroup>',
        "</Project>",
      ].join("\n"),
      "src/Api/Api.csproj": [
        '<Project Sdk="Microsoft.NET.Sdk">',
        "  <!-- <PackageReference Include=\"NotReal\" /> -->",
        '  <ItemGroup><PackageReference Include="Microsoft.Extensions.Http" />',
        '  <PackageReference Update="Other" Version="1.0" /></ItemGroup>',
        "</Project>",
      ].join("\n"),
      "src/Worker/Worker.csproj": '<Project><ItemGroup><PackageReference Include="Dapper" Version="2" /></ItemGroup></Project>',
    });
    expect(await projectConditionMatches(dep("dotnet", "Microsoft.SourceLink.GitHub"), cwd)).toBe(true);
    expect(await projectConditionMatches(dep("dotnet", "Serilog"), cwd)).toBe(false);
    expect(await projectConditionMatches(dep("dotnet", "microsoft.extensions.http"), cwd)).toBe(false);
    expect(await projectConditionMatches(dep("dotnet", "MICROSOFT.EXTENSIONS.HTTP", "workspace"), cwd)).toBe(true);
    expect(await projectConditionMatches(dep("dotnet", "Dapper", "workspace"), cwd)).toBe(true);
    expect(await projectConditionMatches(dep("dotnet", "NotReal", "workspace"), cwd)).toBe(false);
    expect(await projectConditionMatches(dep("dotnet", "Other", "workspace"), cwd)).toBe(false);
  });

  it("reads single-line and block Go require directives without resolving or executing anything", async () => {
    const cwd = await fixture({
      "go.mod": [
        "module example.com/service",
        "go 1.23",
        'require github.com/stretchr/testify v1.10.0 // indirect',
        "require (",
        "  golang.org/x/sync v0.8.0",
        "  golang.org/x/text v0.19.0 // indirect",
        ")",
        "// require github.com/fake/pkg v1.0.0",
      ].join("\n"),
      "tools/go.mod": "module example.com/tools\nrequire github.com/spf13/cobra v1.8.0\n",
    });
    expect(await projectConditionMatches(dep("go", "github.com/stretchr/testify"), cwd)).toBe(true);
    expect(await projectConditionMatches(dep("go", "golang.org/x/sync"), cwd)).toBe(true);
    expect(await projectConditionMatches(dep("go", "golang.org/x/text"), cwd)).toBe(true);
    expect(await projectConditionMatches(dep("go", "github.com/fake/pkg", "workspace"), cwd)).toBe(false);
    expect(await projectConditionMatches(dep("go", "github.com/spf13/cobra"), cwd)).toBe(false);
    expect(await projectConditionMatches(dep("go", "github.com/spf13/cobra", "workspace"), cwd)).toBe(true);
  });

  it("composes predicates and negation, including a missing-manifest no-match", async () => {
    const cwd = await fixture({ "src/Api/Api.csproj": '<Project><PackageReference Include="Dapper" /></Project>' });
    const condition: ProjectCondition = {
      allOf: [
        { anyOf: [dep("node", "express"), dep("dotnet", "Dapper", "workspace")] },
        { not: dep("go", "github.com/example/none") },
      ],
    };
    expect(await projectConditionMatches(condition, cwd)).toBe(true);
    expect(describeProjectCondition(condition)).toContain("dotnet workspace manifests declare dependency Dapper");
  });

  it("reports malformed manifests with path context and does not turn errors into true under not", async () => {
    const badNode = await fixture({ "package.json": '{"dependencies": [' });
    await expect(projectConditionMatches(dep("node", "x"), badNode))
      .rejects.toThrow(/invalid node dependency manifest package\.json/);
    await expect(projectConditionMatches({ not: dep("node", "x") }, badNode))
      .rejects.toThrow(/invalid node dependency manifest/);

    const badGo = await fixture({ "go.mod": "module example.com/x\nrequire (\n  x.org/lib v1.0.0\n" });
    await expect(projectConditionMatches(dep("go", "x.org/lib"), badGo))
      .rejects.toThrow(/unclosed require block/);

    const badDotnet = await fixture({ "Api.csproj": '<Project><PackageReference Include="Dapper" />' });
    await expect(projectConditionMatches(dep("dotnet", "Dapper"), badDotnet))
      .rejects.toThrow(/invalid dotnet dependency manifest Api\.csproj/);

    // Do not stop scanning at the first positive manifest and hide a malformed sibling.
    const siblings = await fixture({
      "a.csproj": '<Project><PackageReference Include="Dapper" /></Project>',
      "z.csproj": "<Project>",
    });
    await expect(projectConditionMatches(dep("dotnet", "Dapper"), siblings))
      .rejects.toThrow(/z\.csproj/);
  });

  it("accepts self-closing XML projects, ignores CDATA, and validates nesting", async () => {
    const selfClosing = await fixture({ "Api.csproj": '<Project Sdk="Microsoft.NET.Sdk" />' });
    expect(await projectConditionMatches(dep("dotnet", "Dapper"), selfClosing)).toBe(false);

    const cdata = await fixture({
      "Api.csproj": [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<Project Sdk="Microsoft.NET.Sdk">',
        '  <PropertyGroup><Example><![CDATA[<PackageReference Include="Fake" />]]></Example></PropertyGroup>',
        '  <ItemGroup><PackageReference Include="Dapper" Version="2.1" /></ItemGroup>',
        '</Project>',
      ].join("\n"),
    });
    expect(await projectConditionMatches(dep("dotnet", "Dapper"), cdata)).toBe(true);
    expect(await projectConditionMatches(dep("dotnet", "Fake"), cdata)).toBe(false);

    const nestedUnclosed = await fixture({
      "Api.csproj": '<Project><ItemGroup><PackageReference Include="Dapper" /></Project>',
    });
    await expect(projectConditionMatches(dep("dotnet", "Dapper"), nestedUnclosed))
      .rejects.toThrow(/mismatched XML end tag/);

    const dtd = await fixture({
      "Api.csproj": '<!DOCTYPE Project [<!ENTITY x SYSTEM "file:///etc/passwd">]><Project />',
    });
    await expect(projectConditionMatches(dep("dotnet", "Dapper"), dtd))
      .rejects.toThrow(/DTD and external entities are not supported/);
  });

  it("decodes quoted Go dependency paths in both require forms", async () => {
    const cwd = await fixture({
      "go.mod": [
        'module "example.org/app"',
        'go 1.24',
        'require "golang.org/x/sync" v0.8.0',
        'require (',
        '  "github.com/stretchr/testify" v1.9.0 // indirect',
        '  github.com/google/uuid v1.6.0',
        ')',
      ].join("\n"),
    });
    expect(await projectConditionMatches(dep("go", "golang.org/x/sync"), cwd)).toBe(true);
    expect(await projectConditionMatches(dep("go", "github.com/stretchr/testify"), cwd)).toBe(true);
    expect(await projectConditionMatches(dep("go", "github.com/google/uuid"), cwd)).toBe(true);
  });

  it("validates non-require Go directives and malformed workspace siblings", async () => {
    const valid = await fixture({
      "go.mod": [
        "module example.org/app", "go 1.24", "toolchain go1.24.0",
        "godebug default=go1.24",
        "require github.com/google/uuid v1.6.0",
        "replace (",
        "  github.com/example/old => ../local",
        "  github.com/example/old2 v1.1.0 => github.com/example/new v1.2.0",
        ")",
        "exclude github.com/example/bad v1.0.0",
        "retract [v1.0.0, v1.1.0]",
        "tool golang.org/x/tools/cmd/stringer",
      ].join("\n"),
    });
    expect(await projectConditionMatches(dep("go", "github.com/google/uuid"), valid)).toBe(true);

    const unclosedReplace = await fixture({ "go.mod": "module example.org/app\nreplace (\n" });
    await expect(projectConditionMatches(dep("go", "x"), unclosedReplace))
      .rejects.toThrow(/unclosed replace block/);

    const unknown = await fixture({ "go.mod": "module example.org/app\nunknown thing\n" });
    await expect(projectConditionMatches({ not: dep("go", "x") }, unknown))
      .rejects.toThrow(/unsupported Go directive: unknown/);

    const siblings = await fixture({
      "go.mod": "module example.org/app\nrequire github.com/google/uuid v1.6.0",
      "sub/go.mod": "module example.org/sub\nreplace (\n",
    });
    await expect(projectConditionMatches(dep("go", "github.com/google/uuid", "workspace"), siblings))
      .rejects.toThrow(/sub\/go\.mod/);
  });

  it("rejects invalid dependency condition schemas before executing them", () => {
    const parse = (projectWhen: unknown) => parseConfig({
      rules: [{ id: "dep-check", question: "Violation?", projectWhen }],
    });
    expect(() => parse(dep("go", "x"))).not.toThrow();
    expect(() => parse({ allOf: [dep("dotnet", "Dapper"), { not: dep("node", "express") }] })).not.toThrow();
    expect(() => parse({ hasDependency: { ecosystem: ["node"], name: "express" } }))
      .toThrow(/hasDependency\.ecosystem/);
    expect(() => parse({ hasDependency: { ecosystem: "python", name: "requests" } }))
      .toThrow(/hasDependency\.ecosystem/);
    expect(() => parse({ hasDependency: { ecosystem: "go", name: "" } }))
      .toThrow(/hasDependency\.name/);
    expect(() => parse({ hasDependency: { ecosystem: "go", name: "x", scope: "all" } }))
      .toThrow(/hasDependency\.scope/);
    expect(() => parse({ hasDependency: { ecosystem: "go", name: "x", arbitrary: true } }))
      .toThrow(/hasDependency\.arbitrary: unknown field/);
    expect(() => parse({ hasDependency: "go" })).toThrow(/hasDependency must be an object/);
  });
});
