// Platform-neutral "@Display Name" → real mention resolution.
//
// This algorithm was written for Slack (src/slack/format.js) and is entirely generic apart from two
// things: the markup a resolved mention renders as, and which control sequences must be defanged
// first. Both are now parameters, so Google Chat (`<users/123>`) and Teams (`<at>Name</at>`) reuse
// the exact same matcher — including the streaming hold-back, which is subtle enough that a second
// copy would drift.
//
// The contract every platform inherits:
//   • only an EXACT directory match is rewritten (longest name wins, so "@Alex Doe" beats "@Alex")
//   • emails (foo@bar), mid-word "@", and text inside `inline code` are never touched
//   • the platform's broadcast words (@here/@channel/@all/@team) are never resolved as people
//   • model-authored control sequences are defanged BEFORE resolution, so the only live mentions in
//     the output are the ones this resolver inserted itself

// Chars that may precede an "@" that STARTS a mention. A word char before "@" means an email
// (foo@bar) or a mid-word "@", never a mention.
const MENTION_BOUNDARY = /[\s(\[{<>"'*_~,;:!?]/;
// A single name word: starts with a letter/number, then letters/numbers and common name punctuation
// (dot, apostrophe, hyphen, underscore). Unicode-aware so "José" / "O'Brien" / "Iuonuț" match.
const NAME_WORD = /^[\p{L}\p{N}][\p{L}\p{N}.'’\-_]*/u;

// Pull up to maxWords leading name-words out of `rest` (the text right after an "@"), returning each
// word's text and end offset so the caller can pick the longest run that matches a real user.
function leadingWords(rest, maxWords) {
  const words = [];
  let idx = 0;
  while (words.length < maxWords) {
    const m = rest.slice(idx).match(NAME_WORD);
    if (!m) break;
    words.push({ text: m[0], end: idx + m[0].length });
    idx += m[0].length;
    const sep = rest.slice(idx).match(/^[  ]/); // exactly one space between name words
    if (!sep) break;
    idx += 1;
  }
  return words;
}

// Index up to which `buf` is safe to emit: everything except a trailing "@…" that could still grow
// into a name. Holds back from the last boundary-"@" unless the name window has clearly closed (a
// newline follows, or enough whitespace-separated words have arrived that no longer name can match).
export function safeCut(buf, maxWords) {
  let p = -1;
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i] !== "@") continue;
    const prev = i === 0 ? "" : buf[i - 1];
    if (i === 0 || MENTION_BOUNDARY.test(prev)) {
      p = i;
      break;
    }
    // a non-boundary "@" (email) can't start a mention — keep scanning left
  }
  if (p === -1) return buf.length; // no pending mention → emit all
  const after = buf.slice(p + 1);
  if (/[\n\r]/.test(after)) return buf.length; // a newline ends the name — safe to resolve + emit
  const parts = after.split(/[  ]+/).filter(Boolean);
  const endsWithSpace = /[  ]$/.test(after);
  const completeWords = endsWithSpace ? parts.length : Math.max(0, parts.length - 1);
  if (completeWords >= maxWords) return buf.length; // no longer name can match → resolve + emit
  return p; // hold back the still-growing "@…"
}

// Build a resolver for one platform.
//   normalizeName  — the directory's name-normalizer (same function that built `dir.map`'s keys)
//   render         — (id, displayName) → the platform's live mention markup
//   defang         — neutralize model-authored control sequences before anything is resolved
//   broadcastNames — normalized names that are platform broadcasts, never people
export function createMentionResolver({ normalizeName, render, defang = (t) => t, broadcastNames = [] } = {}) {
  if (typeof normalizeName !== "function") throw new TypeError("createMentionResolver requires normalizeName()");
  if (typeof render !== "function") throw new TypeError("createMentionResolver requires render()");
  const reserved = new Set(broadcastNames.map((n) => normalizeName(n)));

  // Given the text after an "@", return the matched user id + the length consumed, or null. Tries
  // the longest run of words first so "@Alex Doe" beats a user literally named "Alex".
  function matchMention(rest, dir) {
    const words = leadingWords(rest, dir.maxWords);
    for (let k = words.length; k >= 1; k--) {
      const phrase = words.slice(0, k).map((w) => w.text).join(" ");
      const key = normalizeName(phrase);
      if (reserved.has(key)) continue;
      const id = dir.map.get(key);
      if (id) return { id, phrase, len: words[k - 1].end };
    }
    return null;
  }

  function resolveSegment(seg, dir) {
    let out = "";
    let i = 0;
    while (i < seg.length) {
      const at = seg.indexOf("@", i);
      if (at === -1) {
        out += seg.slice(i);
        break;
      }
      out += seg.slice(i, at);
      const prev = at === 0 ? "" : seg[at - 1];
      if (at !== 0 && !MENTION_BOUNDARY.test(prev)) {
        out += "@"; // not a mention boundary (e.g. an email) — leave the "@" as-is
        i = at + 1;
        continue;
      }
      const hit = matchMention(seg.slice(at + 1), dir);
      if (hit) {
        out += render(hit.id, hit.phrase);
        i = at + 1 + hit.len;
      } else {
        out += "@";
        i = at + 1;
      }
    }
    return out;
  }

  // Rewrite "@Name" → the platform's mention markup, skipping `inline code` spans. `dir` is a
  // directory snapshot ({ map, maxWords }); with an empty/missing map the text is unchanged.
  function resolve(text, dir) {
    if (!text || !dir?.map?.size) return text || "";
    return text
      .split(/(`[^`]*`)/)
      .map((s) => (s.startsWith("`") && s.endsWith("`") ? s : resolveSegment(s, dir)))
      .join("");
  }

  // Streaming variant: a live stream appends the answer in arbitrary delta slices, so a single
  // "@Name" can straddle a chunk boundary. push() emits everything safe to send now (completed
  // mentions resolved) and keeps only a short trailing run that might still be growing into an
  // "@name"; flush() releases the remainder at the end of the stream.
  function stream(dir) {
    let buf = "";
    const maxWords = dir?.maxWords || 1;
    return {
      push(t) {
        buf += t || "";
        let cut = safeCut(buf, maxWords);
        // A trailing "<" may be the start of a control sequence straddling two deltas — hold it
        // back so `defang` sees the full sequence in one piece.
        if (cut === buf.length && buf.endsWith("<")) cut -= 1;
        const emit = resolve(defang(buf.slice(0, cut)), dir);
        buf = buf.slice(cut);
        return emit;
      },
      flush() {
        const out = resolve(defang(buf), dir);
        buf = "";
        return out;
      },
    };
  }

  return { resolve, stream, matchMention };
}
