// On-demand channel-memory retrieval. Markdown in the channel folder is canonical; SQLite FTS5
// is a derived cache rebuilt before search so hand edits and admin-UI writes are visible at once.
import path from "node:path";
import { readdir } from "node:fs/promises";
import { getDb } from "../db/index.js";
import { memoryFtsPresent } from "../db/fts.js";
import { readNoFollow } from "./safe-fs.js";
import { MEM_DIR, MEM_FILE } from "./channel-memory.js";

const MAX_RESULTS = 20;
const VALID_TOPIC = /^[a-z0-9][a-z0-9-]*\.md$/i;

async function documents(cwd) {
  const docs = [];
  const index = await readNoFollow(path.join(cwd, MEM_FILE));
  if (index?.trim()) docs.push({ source: MEM_FILE, title: "Channel memory index", body: index });
  let names = [];
  try {
    names = (await readdir(path.join(cwd, MEM_DIR), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && VALID_TOPIC.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    // A channel without topic files simply has no topic documents.
  }
  for (const name of names) {
    const body = await readNoFollow(path.join(cwd, MEM_DIR, name));
    if (body?.trim()) docs.push({ source: `${MEM_DIR}/${name}`, title: name.slice(0, -3).replaceAll("-", " "), body });
  }
  return docs;
}

export async function rebuildMemoryIndex(cwd, channelSlug) {
  const docs = await documents(cwd);
  const db = getDb();
  if (!memoryFtsPresent(db)) return docs; // no FTS5 in this Node build — the scan below reads docs directly
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM channel_memory_fts WHERE channel_slug = ?").run(channelSlug);
    const insert = db.prepare("INSERT INTO channel_memory_fts(channel_slug, source, title, body) VALUES(?, ?, ?, ?)");
    for (const doc of docs) insert.run(channelSlug, doc.source, doc.title, doc.body);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return docs;
}

function queryTerms(query) {
  return (String(query || "").normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu) || []).slice(0, 12);
}

function ftsQuery(query) {
  return queryTerms(query).map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

// Plain-scan fallback for a Node build whose SQLite has no FTS5: the same AND semantics over the
// same documents (every term must occur, diacritics and case folded), ranked by title hits then
// body hits, with a bracketed excerpt around the first match — so the tool answers the same shape
// on the documented Node floor, only without bm25 ranking.
const fold = (text) => String(text).normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();

function scanExcerpt(body, term) {
  const words = String(body).split(/\s+/).filter(Boolean);
  const at = words.findIndex((w) => fold(w).includes(term));
  if (at < 0) return words.slice(0, 24).join(" ");
  const start = Math.max(0, at - 8);
  const slice = words.slice(start, start + 24).map((w) => (fold(w).includes(term) ? `[${w}]` : w));
  return `${start > 0 ? "… " : ""}${slice.join(" ")}${start + 24 < words.length ? " …" : ""}`;
}

function scanDocuments(docs, terms, limit) {
  const wanted = terms.map(fold);
  const hits = [];
  for (const doc of docs) {
    const title = fold(doc.title);
    const body = fold(doc.body);
    if (!wanted.every((t) => title.includes(t) || body.includes(t))) continue;
    let score = 0;
    for (const t of wanted) {
      if (title.includes(t)) score += 2;
      score += Math.min(10, body.split(t).length - 1);
    }
    hits.push({ source: doc.source, title: doc.title, excerpt: scanExcerpt(doc.body, wanted[0]), rank: -score });
  }
  return hits.sort((a, b) => a.rank - b.rank || a.source.localeCompare(b.source)).slice(0, limit);
}

export async function searchChannelMemory(cwd, channelSlug, query, limit = 8) {
  const match = ftsQuery(query);
  if (!match) return [];
  const docs = await rebuildMemoryIndex(cwd, channelSlug);
  const cap = Math.max(1, Math.min(MAX_RESULTS, Number(limit) || 8));
  if (!memoryFtsPresent(getDb())) return scanDocuments(docs, queryTerms(query), cap);
  return getDb().prepare(`
    SELECT source, title,
      snippet(channel_memory_fts, 3, '[', ']', ' … ', 24) AS excerpt,
      bm25(channel_memory_fts, 0.0, 0.0, 2.0, 1.0) AS rank
    FROM channel_memory_fts
    WHERE channel_slug = ? AND channel_memory_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(channelSlug, match, cap);
}

export async function readChannelMemorySource(cwd, source) {
  const normalized = String(source || "").trim();
  if (normalized === MEM_FILE) return (await readNoFollow(path.join(cwd, MEM_FILE))) ?? null;
  const match = normalized.match(/^memory\/([a-z0-9][a-z0-9-]*\.md)$/i);
  if (!match) throw new Error("source must be MEMORY.md or memory/<topic>.md");
  return (await readNoFollow(path.join(cwd, MEM_DIR, match[1]))) ?? null;
}
