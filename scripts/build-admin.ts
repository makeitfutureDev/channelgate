// Publish browser ESM as ordinary .js so self-hosted installs and static browser fixtures
// consume identical bytes. Only development and release checks need the pinned compiler.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { adminModuleName } from "../src/web/admin-module-names.ts";

const check = process.argv.includes("--check");
const sources = new URL("../ui/admin/", import.meta.url);
const output = new URL("../public/", import.meta.url);
const marker = "// Generated from ui/admin/";
const expected = new Set<string>();
for (const name of readdirSync(sources).sort()) {
  if (!name.endsWith(".ts") || !adminModuleName.test(name.slice(0, -3))) throw new Error(`Unsupported admin module name: ${name}`);
  const scriptName = name.slice(0, -3) + ".js";
  expected.add(scriptName);
  const target = new URL(scriptName, output);
  const source = readFileSync(new URL(name, sources), "utf8");
  const js = ts.transpileModule(source, {
    fileName: name, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023, newLine: ts.NewLineKind.LineFeed },
  }).outputText;
  const built = marker + name + " by npm run build:admin.\n" + js;
  const disk = existsSync(target) ? readFileSync(target, "utf8") : undefined;
  if (disk === built) continue;
  if (check) throw new Error(`Regenerate public/${scriptName} with npm run build:admin`);
  if (disk !== undefined && !disk.startsWith(marker)) throw new Error(`A hand-written public/${scriptName} already exists`);
  writeFileSync(target, built);
}
for (const name of readdirSync(output)) {
  if (expected.has(name) || !name.endsWith(".js")) continue;
  if (readFileSync(new URL(name, output), "utf8").startsWith(marker)) throw new Error(`Remove obsolete generated public/${name}`);
}
