// Static rule (container-secrets P4): no file write under a container-visible artifact path whose
// CONTENT comes from a secret resolver.
//
// Why: the artifact dir (`channelArtifactDir`, `target.artifactDir`, the SSH users dir under it) is
// bind-mounted into the channel container at its identical path, so every process in the box —
// every member's turn — can read what the daemon writes there. P1–P3 moved every credential out of
// those files (the remote-MCP relay, placeholders, the access-only login files); this rule keeps a
// refactor from quietly writing one back. It is a deliberately SIMPLE, explainable pass over src/,
// not a data-flow analysis:
//   1. a name is "artifact-derived" when its declaration or assignment mentions one of the ROOTS, or
//      a name already artifact-derived (repeated to a fixpoint; by name, per file — conservative);
//   2. a write call (WRITERS) whose PATH argument mentions a root or an artifact-derived name is
//      flagged when its CONTENT argument mentions one of the SECRET_SOURCES — the resolver outputs
//      that hold real values (the Composio/toolbox tokens, a relay's token, a resolved run env, the
//      redactor's list of real values).
// A write that is deliberate and reviewed carries `static-check: allow-secret-artifact-write <why>`
// in a comment on one of the two lines above it.
import { parse } from "acorn";

export const ARTIFACT_ROOTS = /\b(?:artifactDir|runArtifactRoot|sshUserDir|sshUsersDir|channelArtifactDir)\b/;
export const SECRET_SOURCES = /\b(?:composioUserToken|composioToken|toolboxToken|makeToolboxKey|resolvedRunEnv|realValues)\b|\brelay\??\.token\b/;
export const WRITERS = new Set(["writeFile", "writeFileSync", "appendFile", "appendFileSync", "writePrivate", "writeSecretFile"]);
export const ALLOW_MARKER = "static-check: allow-secret-artifact-write";

function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) for (const item of child) walk(item, visit);
    else if (child && typeof child === "object" && typeof child.type === "string") walk(child, visit);
  }
}

function calleeName(callee) {
  if (callee?.type === "Identifier") return callee.name;
  if (callee?.type === "MemberExpression" && !callee.computed && callee.property?.type === "Identifier") return callee.property.name;
  return "";
}

const mentions = (text, names) => [...names].some((name) => new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(text));

// → ["<file>:<line>: <message>", …] for one source file.
export function findSecretArtifactWrites(file, source) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true, locations: true });
  const text = (node) => source.slice(node.start, node.end);
  const bindings = [];
  walk(ast, (node) => {
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && node.init) bindings.push([node.id.name, node.init]);
    if (node.type === "AssignmentExpression" && node.left?.type === "Identifier") bindings.push([node.left.name, node.right]);
  });
  const derived = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, init] of bindings) {
      if (derived.has(name)) continue;
      const body = text(init);
      if (ARTIFACT_ROOTS.test(body) || mentions(body, derived)) {
        derived.add(name);
        changed = true;
      }
    }
  }
  const lines = source.split("\n");
  const out = [];
  walk(ast, (node) => {
    if (node.type !== "CallExpression" || !WRITERS.has(calleeName(node.callee)) || node.arguments.length < 2) return;
    const target = text(node.arguments[0]);
    if (!ARTIFACT_ROOTS.test(target) && !mentions(target, derived)) return;
    const content = text(node.arguments[1]);
    const secret = SECRET_SOURCES.exec(content);
    if (!secret) return;
    const line = node.loc.start.line;
    if (lines.slice(Math.max(0, line - 3), line).some((l) => l.includes(ALLOW_MARKER))) return;
    out.push(`${file}:${line}: ${calleeName(node.callee)}() writes \`${secret[0]}\` under a container-visible artifact path (${target.slice(0, 80)}) — keep real secret values out of the artifact dir, or mark a reviewed exception with "${ALLOW_MARKER} <why>"`);
  });
  return out;
}
