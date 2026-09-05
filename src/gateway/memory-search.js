// On-demand channel-memory retrieval. Markdown in the channel folder is canonical; SQLite FTS5
// is a derived cache rebuilt before search so hand edits and admin-UI writes are visible at once.
import path from "node:path";
import { readdir } from "node:fs/promises";
import { getDb } from "../db/index.js";
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

function ftsQuery(query) {
  const terms = String(query || "").normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu) || [];
  return terms.slice(0, 12).map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

export async function searchChannelMemory(cwd, channelSlug, query, limit = 8) {
  const match = ftsQuery(query);
  if (!match) return [];
  await rebuildMemoryIndex(cwd, channelSlug);
  return getDb().prepare(`
    SELECT source, title,
      snippet(channel_memory_fts, 3, '[', ']', ' … ', 24) AS excerpt,
      bm25(channel_memory_fts, 0.0, 0.0, 2.0, 1.0) AS rank
    FROM channel_memory_fts
    WHERE channel_slug = ? AND channel_memory_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(channelSlug, match, Math.max(1, Math.min(MAX_RESULTS, Number(limit) || 8)));
}

export async function readChannelMemorySource(cwd, source) {
  const normalized = String(source || "").trim();
  if (normalized === MEM_FILE) return (await readNoFollow(path.join(cwd, MEM_FILE))) ?? null;
  const match = normalized.match(/^memory\/([a-z0-9][a-z0-9-]*\.md)$/i);
  if (!match) throw new Error("source must be MEMORY.md or memory/<topic>.md");
  return (await readNoFollow(path.join(cwd, MEM_DIR, match[1]))) ?? null;
}
