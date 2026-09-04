// SKILL.md frontmatter READER for the local skill catalog. It parses the YAML subset skills
// actually use (scalars, quoted scalars, block and inline lists, one-or-more levels of nested
// maps, `>`/`|` block scalars, multi-line plain scalars, comments) into a plain object and hands
// back the body untouched. It never rewrites a file: the catalog stores the exact bytes and treats
// everything this returns as a DERIVED index (docs/SKILLS.md, "lossless content"). A key it does
// not understand is kept as its raw string rather than dropped, and nothing here throws — a
// malformed header simply yields fewer fields, so an odd skill is still importable and inspectable.

const BLOCK_SCALAR = /^[|>][+-]?$/;

function indentOf(line) {
  const m = line.match(/^ */);
  return m ? m[0].length : 0;
}

function isBlankOrComment(line) {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

// Strip a trailing ` # comment` from a plain scalar (a `#` needs whitespace before it in YAML).
function stripComment(s) {
  const i = s.search(/\s#/);
  return i === -1 ? s : s.slice(0, i);
}

function parseDoubleQuoted(s) {
  // s starts with a double quote; read to the closing unescaped quote.
  let out = "";
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      const n = s[i + 1];
      i++;
      if (n === "n") out += "\n";
      else if (n === "t") out += "\t";
      else if (n === "r") out += "\r";
      else if (n === "u" && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) {
        out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16));
        i += 4;
      } else out += n;
      continue;
    }
    if (c === '"') return out;
    out += c;
  }
  return out; // unterminated — take what we have
}

function parseSingleQuoted(s) {
  let out = "";
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      if (s[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      return out;
    }
    out += c;
  }
  return out;
}

// Split an inline `[a, "b, c", d]` / `{k: v, k2: v2}` body on top-level commas.
function splitInline(body) {
  const parts = [];
  let cur = "";
  let quote = "";
  let depth = 0;
  for (const c of body) {
    if (quote) {
      cur += c;
      if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "[" || c === "{") depth++;
    if (c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== "" || parts.length) parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

export function parseScalar(raw) {
  const s = String(raw ?? "").trim();
  if (s === "") return "";
  if (s.startsWith('"')) return parseDoubleQuoted(s);
  if (s.startsWith("'")) return parseSingleQuoted(s);
  if (s.startsWith("[") && s.endsWith("]")) return splitInline(s.slice(1, -1)).map(parseScalar);
  if (s.startsWith("{") && s.endsWith("}")) {
    const obj = {};
    for (const pair of splitInline(s.slice(1, -1))) {
      const i = pair.indexOf(":");
      if (i === -1) continue;
      obj[parseScalar(pair.slice(0, i))] = parseScalar(pair.slice(i + 1));
    }
    return obj;
  }
  const plain = stripComment(s).trim();
  if (plain === "true") return true;
  if (plain === "false") return false;
  if (plain === "null" || plain === "~") return null;
  return plain;
}

// A mapping key at the start of a (dedented) line: bare, or quoted. Returns { key, rest } or null.
function splitKey(content) {
  const m = content.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s:#"'\-][^:]*?)\s*:(?:\s+(.*)|$)/);
  if (!m) return null;
  const key = parseScalar(m[1]);
  return { key: typeof key === "string" ? key : String(key), rest: (m[2] ?? "").trim() };
}

function looksLikeKey(content) {
  return splitKey(content) !== null;
}

// Collect a block scalar's lines (more indented than `indent`, or blank) starting at `i`.
function readBlockScalar(lines, i, indent, indicator) {
  const body = [];
  let j = i;
  while (j < lines.length) {
    const line = lines[j];
    if (line.trim() === "") {
      body.push("");
      j++;
      continue;
    }
    if (indentOf(line) <= indent) break;
    body.push(line);
    j++;
  }
  // Drop trailing blank lines (chomping) and the common indent.
  while (body.length && body[body.length - 1] === "") body.pop();
  const common = body.filter((l) => l !== "").reduce((m, l) => Math.min(m, indentOf(l)), Infinity);
  const stripped = body.map((l) => (l === "" ? "" : l.slice(common === Infinity ? 0 : common)));
  let value;
  if (indicator.startsWith("|")) value = stripped.join("\n");
  else {
    // Folded: adjacent lines join with a space; a blank line is a paragraph break.
    value = "";
    for (const l of stripped) {
      if (l === "") value += "\n";
      else value += (value === "" || value.endsWith("\n") ? "" : " ") + l;
    }
  }
  return { value: indicator.endsWith("+") ? `${value}\n` : value, next: j };
}

function parseSequence(lines, start, indent) {
  const arr = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankOrComment(line)) {
      i++;
      continue;
    }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) {
      i++;
      continue; // stray deeper line — skip
    }
    const content = line.slice(ind);
    if (!(content === "-" || content.startsWith("- "))) break;
    const rest = content.slice(1).trim();
    if (rest === "") {
      const r = parseNode(lines, i + 1, ind + 1);
      arr.push(r.value);
      i = r.next;
      continue;
    }
    if (looksLikeKey(rest) && !rest.startsWith("[") && !rest.startsWith("{") && !rest.startsWith('"') && !rest.startsWith("'")) {
      // A mapping that starts on the dash line: re-indent it and parse as a mapping block.
      const copy = lines.slice();
      copy[i] = " ".repeat(ind + 2) + rest;
      const r = parseMapping(copy, i, ind + 2);
      arr.push(r.value);
      i = r.next;
      continue;
    }
    arr.push(parseScalar(rest));
    i++;
  }
  return { value: arr, next: i };
}

function parseMapping(lines, start, indent) {
  const obj = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankOrComment(line)) {
      i++;
      continue;
    }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) {
      i++;
      continue; // stray deeper line — skip
    }
    const content = line.slice(ind);
    const kv = splitKey(content);
    if (!kv) {
      i++;
      continue;
    }
    const { key, rest } = kv;
    if (BLOCK_SCALAR.test(rest)) {
      const r = readBlockScalar(lines, i + 1, ind, rest);
      obj[key] = r.value;
      i = r.next;
      continue;
    }
    if (rest === "") {
      // Nested block (map or list) on the following deeper lines, else an empty value.
      let j = i + 1;
      while (j < lines.length && isBlankOrComment(lines[j])) j++;
      if (j < lines.length && indentOf(lines[j]) > ind) {
        const r = parseNode(lines, j, indentOf(lines[j]));
        obj[key] = r.value;
        i = r.next;
        continue;
      }
      // `key:` followed by a list at the SAME indent is legal YAML for a sequence value.
      if (j < lines.length && indentOf(lines[j]) === ind && /^-( |$)/.test(lines[j].slice(ind))) {
        const r = parseSequence(lines, j, ind);
        obj[key] = r.value;
        i = r.next;
        continue;
      }
      obj[key] = "";
      i = j;
      continue;
    }
    // Plain scalar, possibly continued on deeper-indented lines.
    let value = rest;
    let j = i + 1;
    const quoted = rest.startsWith('"') || rest.startsWith("'");
    while (j < lines.length) {
      const nxt = lines[j];
      if (nxt.trim() === "") break;
      const nind = indentOf(nxt);
      if (nind <= ind) break;
      if (!quoted && looksLikeKey(nxt.slice(nind))) break;
      value += ` ${nxt.trim()}`;
      j++;
    }
    obj[key] = parseScalar(value);
    i = j;
  }
  return { value: obj, next: i };
}

function parseNode(lines, start, indent) {
  let i = start;
  while (i < lines.length && isBlankOrComment(lines[i])) i++;
  if (i >= lines.length) return { value: null, next: i };
  const content = lines[i].slice(indentOf(lines[i]));
  if (content === "-" || content.startsWith("- ")) return parseSequence(lines, i, indentOf(lines[i]));
  return parseMapping(lines, i, indentOf(lines[i]));
}

// Parse a SKILL.md text. Returns { hasFrontmatter, data, body, raw }. `body` is the markdown after
// the closing `---` (the whole text when there is no header); `raw` is the untouched header text.
export function parseFrontmatter(text) {
  const src = String(text ?? "").replace(/^﻿/, "");
  const lines = src.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") return { hasFrontmatter: false, data: {}, body: src, raw: "" };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "---" || t === "...") {
      close = i;
      break;
    }
  }
  if (close === -1) return { hasFrontmatter: false, data: {}, body: src, raw: "" };
  const header = lines.slice(1, close);
  let data = {};
  try {
    const parsed = parseMapping(header, 0, header.findIndex((l) => !isBlankOrComment(l)) === -1 ? 0 : indentOf(header.find((l) => !isBlankOrComment(l))));
    data = parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value) ? parsed.value : {};
  } catch {
    data = {};
  }
  return { hasFrontmatter: true, data, body: lines.slice(close + 1).join("\n"), raw: header.join("\n") };
}

// ── Derived skill metadata ──────────────────────────────────────────────────────────────────

const str = (v) => (v == null ? "" : typeof v === "string" ? v : Array.isArray(v) || typeof v === "object" ? "" : String(v));
const collapse = (s) => str(s).replace(/\s+/g, " ").trim();

function list(v) {
  if (Array.isArray(v)) return v.map((x) => collapse(x)).filter(Boolean);
  const s = collapse(v);
  if (!s) return [];
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

// The catalog's slug form of a skill name: what Skills Manager did (lower-case, runs of
// non-alphanumerics become one dash), so a synced skill keeps the identity it had there.
export function slugFromName(name) {
  return collapse(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

// Pull the fields the catalog indexes out of a parsed header. Everything else stays in `meta`.
// `requires` (the plan's spelling) and `dependencies` (the pre-cloud Skills Manager server's) both
// name skills this one loads; `related_skills` is a soft hint and is only kept in meta.
export function skillMetadata(data = {}) {
  const meta = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const nested = meta.metadata && typeof meta.metadata === "object" && !Array.isArray(meta.metadata) ? meta.metadata : {};
  const requires = [...list(meta.requires), ...list(meta.dependencies), ...list(nested.requires)]
    .map((n) => slugFromName(n))
    .filter(Boolean);
  const allowedTools = Array.isArray(meta["allowed-tools"]) ? meta["allowed-tools"].map(collapse).filter(Boolean) : list(meta["allowed-tools"]);
  return {
    name: collapse(meta.name),
    description: collapse(meta.description),
    version: collapse(meta.version || nested.version),
    category: collapse(meta.category || nested.category),
    subcategory: collapse(meta.subcategory || nested.subcategory),
    tags: [...new Set(list(meta.tags))],
    complexity: collapse(meta.complexity),
    author: collapse(meta.author || nested.author),
    requires: [...new Set(requires)],
    allowedTools,
  };
}
