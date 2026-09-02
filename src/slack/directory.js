// Cached workspace user directory: a name → Slack-user-id map built from `users.list`, used to turn
// plain "@Display Name" text the agent writes into real "<@UID>" mentions (see resolveMentions in
// format.js). Loading the whole workspace once and caching it means a reply needs ZERO id lookups at
// generation time — the agent just writes the name it already knows and the daemon rewrites it.
//
// Requires the `users:read` bot scope (the same scope the ID→name `users.info` lookups already use;
// the boot scope self-check will warn if it's missing). Never throws — on any error it returns the
// last good snapshot (or an empty one), so mention resolution simply no-ops until the next refresh.

const TTL_MS = 15 * 60 * 1000; // refresh the snapshot at most this often
const MAX_WORDS_CAP = 5; // upper bound on words in a name we'll try to match (bounds the stream holdback)

// Normalize a name for map keys AND lookups so both sides agree: NFC, lowercased, whitespace
// collapsed to single spaces, trimmed. Exported so format.js keys lookups the identical way.
export function normalizeName(s) {
  return String(s || "")
    .normalize("NFC")
    .replace(/[\s ]+/g, " ")
    .trim()
    .toLowerCase();
}

// The live snapshot: { map: Map<normName, userId>, maxWords }. Empty until the first load resolves.
let snapshot = { map: new Map(), maxWords: 1, at: 0 };
let inflight = null; // dedupe concurrent refreshes (shared promise)

// Add a candidate name → id, but never GUESS: if two different users normalize to the same name,
// drop the key entirely (ambiguous) so we can't tag the wrong person.
function addName(map, ambiguous, name, id) {
  const key = normalizeName(name);
  if (!key || ambiguous.has(key)) return;
  const existing = map.get(key);
  if (existing && existing !== id) {
    map.delete(key); // collision → unusable
    ambiguous.add(key);
    return;
  }
  map.set(key, id);
}

async function fetchAllMembers(client) {
  const members = [];
  let cursor;
  do {
    const res = await client.users.list({ limit: 200, ...(cursor ? { cursor } : {}) });
    if (Array.isArray(res.members)) members.push(...res.members);
    cursor = res.response_metadata?.next_cursor || "";
  } while (cursor);
  return members;
}

// Build a snapshot from an already-fetched users.list. Includes every non-deleted human (skips
// deleted accounts, Slackbot, and the "@here/@channel/@everyone" broadcast names never come from
// here anyway). A person's handle (`name`), display name, and real name all resolve to their id.
// Exported (and client-free) so it can be unit-tested against fixture members.
export function buildDirectory(members) {
  const map = new Map();
  const ambiguous = new Set();
  // token → Set(id) for the FIRST word of every name a person goes by. addName's collision check
  // only fires on identical whole keys, which misses the more common trap: one person's handle
  // being another person's first name (e.g. Sam Rivera's handle is "sam", so "@Sam" would
  // silently tag them instead of Sam Lee). Collected alongside the map, applied below.
  const firstWords = new Map();
  for (const m of members) {
    if (!m || m.deleted || m.id === "USLACKBOT") continue;
    const id = m.id;
    const p = m.profile || {};
    for (const name of [p.display_name, p.display_name_normalized, m.real_name, p.real_name_normalized, m.name]) {
      if (!name) continue;
      addName(map, ambiguous, name, id);
      const first = normalizeName(name).split(" ")[0];
      if (!first) continue;
      if (!firstWords.has(first)) firstWords.set(first, new Set());
      firstWords.get(first).add(id);
    }
  }
  // Drop every single-word key that two or more people could answer to. Multi-word keys survive —
  // matchMention tries the longest phrase first, so "@Sam Lee" still resolves exactly while
  // the bare "@Sam" now matches nothing and is posted as literal text. Silence beats mistagging
  // a real colleague. Counting distinct ids means a lone "Tomas" whose real name is "Tomas Ross" is
  // NOT self-ambiguous and keeps working.
  for (const key of [...map.keys()]) {
    if (key.includes(" ")) continue;
    if ((firstWords.get(key)?.size ?? 0) > 1) map.delete(key);
  }
  let maxWords = 1;
  for (const key of map.keys()) maxWords = Math.max(maxWords, key.split(" ").length);
  return { map, maxWords: Math.min(maxWords, MAX_WORDS_CAP), at: Date.now() };
}

async function build(client) {
  return buildDirectory(await fetchAllMembers(client));
}

// Force a refresh now (deduped). Returns the new snapshot, or keeps the old one on failure. Used at
// boot to warm the cache and by getDirectory when the snapshot has gone stale.
export async function refreshDirectory(client) {
  if (!client) return snapshot;
  if (inflight) return inflight;
  inflight = build(client)
    .then((snap) => {
      snapshot = snap;
      return snap;
    })
    .catch((e) => {
      console.warn(`[slack] user directory refresh failed: ${e.message}`);
      return snapshot; // keep serving the last good snapshot
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// The directory to pass to resolveMentions. Returns the cached snapshot immediately when fresh;
// otherwise triggers a refresh. Awaits the refresh only when there's nothing cached yet (cold), so a
// steady-state reply never blocks on the network — a stale-but-usable snapshot is served while the
// refresh runs in the background.
export async function getDirectory(client) {
  const age = snapshot.at ? Date.now() - snapshot.at : Infinity;
  if (age < TTL_MS) return snapshot;
  const refresh = refreshDirectory(client);
  if (snapshot.map.size === 0) return refresh; // cold start — wait for the first load
  refresh.catch(() => {}); // warm but stale — refresh in the background, serve what we have
  return snapshot;
}

// Reset — for tests only.
export function _resetDirectory() {
  snapshot = { map: new Map(), maxWords: 1, at: 0 };
  inflight = null;
}
