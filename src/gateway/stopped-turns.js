// One-shot context for user-stopped interactive turns.
//
// A Codex turn killed before completion may not record the user's latest request inside Codex's
// resumable thread, while request 2+ in a Slack thread still has the previous Codex thread_id. Keep
// just the stopped user request, then prepend it once to the next message in that same Slack thread.
import { getDb, toJson, fromJson } from "../db/index.js";

const MAX_STOPPED_PROMPT_CHARS = 20_000;

function key(slug, threadKey) {
  return `${slug || ""}::${threadKey || ""}`;
}

function truncatePrompt(text) {
  const s = String(text || "").trim();
  if (s.length <= MAX_STOPPED_PROMPT_CHARS) return s;
  return `${s.slice(0, MAX_STOPPED_PROMPT_CHARS)}\n...(truncated)`;
}

export function formatStoppedTurnContext(rec) {
  const text = truncatePrompt(rec?.text);
  if (!text) return "";
  return (
    "[Stopped previous turn context — the previous user request in this Slack thread was stopped before completion. " +
    "Treat it as context for what the user may be continuing or revising; the current user message below is authoritative.]\n" +
    "<previous_stopped_request>\n" +
    text +
    "\n</previous_stopped_request>\n" +
    "[End stopped previous turn context.]\n\n"
  );
}

export function saveStoppedTurn({ channelId = "", slug = "", threadKey = "", authorId = "", text = "", attachments = [] } = {}) {
  const clean = truncatePrompt(text);
  if (!slug || !threadKey || !clean) return false;
  try {
    getDb()
      .prepare("INSERT INTO stopped_turns(slug, thread_key, data) VALUES(?, ?, ?) ON CONFLICT(slug, thread_key) DO UPDATE SET data = excluded.data")
      .run(slug, threadKey, toJson({ channelId, slug, threadKey, authorId, text: clean, attachments, stoppedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

export function takeStoppedTurn(slug, threadKey) {
  if (!slug || !threadKey) return null;
  const db = getDb();
  try {
    const row = db.prepare("SELECT data FROM stopped_turns WHERE slug = ? AND thread_key = ?").get(slug, threadKey);
    if (!row) return null;
    db.prepare("DELETE FROM stopped_turns WHERE slug = ? AND thread_key = ?").run(slug, threadKey);
    return fromJson(row.data, null);
  } catch {
    return null;
  }
}

export function clearStoppedTurn(slug, threadKey) {
  if (!slug || !threadKey) return false;
  try {
    return getDb().prepare("DELETE FROM stopped_turns WHERE slug = ? AND thread_key = ?").run(slug, threadKey).changes > 0;
  } catch {
    return false;
  }
}
