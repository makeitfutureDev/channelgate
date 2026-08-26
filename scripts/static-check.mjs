#!/usr/bin/env node
// Incremental static gate. It deliberately checks objective invariants first; adopting a style
// linter/type checker repo-wide remains a ratchet, not a flag day. The one parser-backed check
// is no-undef (acorn + acorn-globals, two tiny pinned devDeps): this repo is no-build ES modules
// with manually wired imports, so a removed import with a surviving call site is a RUNTIME
// ReferenceError invisible to `node --check` — exactly how two production buttons broke in the
// 2026-08 phase-E refactor.
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import detectGlobals from "acorn-globals";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const roots = ["src", "scripts", "test", "public"];
const files = [];

function walk(rel) {
  const abs = path.join(root, rel);
  for (const item of readdirSync(abs, { withFileTypes: true })) {
    const child = path.join(rel, item.name);
    if (item.isDirectory()) walk(child);
    else if (/\.(?:js|mjs)$/.test(item.name)) files.push(child);
  }
}

// Names that are legitimately global. Runtime globals come from the running Node process (which
// shares fetch/URL/AbortSignal/etc. with browsers); browser-only names are listed explicitly so
// a typo'd identifier in public/ can't hide behind a catch-all.
const RUNTIME_GLOBALS = new Set(Object.getOwnPropertyNames(globalThis));
const BROWSER_GLOBALS = new Set([
  "window", "document", "location", "history", "navigator", "alert", "confirm", "prompt",
  "localStorage", "sessionStorage", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
  "EventSource", "FileReader", "DOMParser", "MutationObserver", "ResizeObserver", "IntersectionObserver",
  "HTMLElement", "Node", "NodeList", "CustomEvent", "KeyboardEvent", "ClipboardItem", "matchMedia",
  "requestIdleCallback", "IntersectionObserverEntry", "getSelection", "scrollTo", "innerWidth", "innerHeight",
]);

function undeclaredIdentifiers(file, source) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true, locations: true });
  const out = [];
  for (const found of detectGlobals(ast)) {
    if (RUNTIME_GLOBALS.has(found.name)) continue;
    if (file.startsWith("public/") && BROWSER_GLOBALS.has(found.name)) continue;
    for (const node of found.nodes) {
      // typeof probes are a legitimate feature-detection idiom, never a crash.
      if (node.parents?.some?.((p) => p.type === "UnaryExpression" && p.operator === "typeof")) continue;
      out.push(`${file}:${node.loc?.start?.line ?? "?"}: '${found.name}' is not defined`);
      break; // one report per name per file keeps the output readable
    }
  }
  return out;
}

for (const dir of roots) walk(dir);
const errors = [];
for (const file of files.sort()) {
  const syntax = spawnSync(process.execPath, ["--check", file], { cwd: root, encoding: "utf8" });
  if (syntax.status !== 0) errors.push(`${file}: ${String(syntax.stderr || syntax.stdout).trim()}`);
  const source = readFileSync(path.join(root, file), "utf8");
  if (syntax.status === 0) {
    try {
      errors.push(...undeclaredIdentifiers(file, source));
    } catch (e) {
      errors.push(`${file}: no-undef parse failed: ${e.message}`);
    }
  }
  const lines = source.split("\n");
  lines.forEach((line, index) => {
    if (/[ \t]+$/.test(line)) errors.push(`${file}:${index + 1}: trailing whitespace`);
    if (line.includes("\t")) errors.push(`${file}:${index + 1}: tab character`);
  });
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`Static check passed: ${files.length} JavaScript files parse, no undeclared identifiers; whitespace is clean.`);
