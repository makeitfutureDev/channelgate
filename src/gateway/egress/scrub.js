// Response scrubbing: put the placeholder back wherever an upstream echoes a real value.
//
// Why: defense in depth. A container only ever holds placeholders, but an upstream that echoes the
// credential it just received (a debug endpoint, an error page quoting the Authorization header,
// a "whoami" that returns the token) would hand the real value straight back into the container.
// So a text response to a request that swapped at least one grant is streamed through this
// Transform, which replaces every occurrence of a swapped value with its placeholder token.
//
// Streaming, not buffering: SSE and chunked model responses must stay live, so the transform emits
// everything except the shortest tail that could still be the START of a value (usually nothing),
// which is how a value split across two chunks is still caught. Matching is byte-exact: values and
// chunks are compared as latin1 strings (one char per byte), so multi-byte UTF-8 never shifts an
// offset. Compressed bodies are NOT decompressed (the proxy passes them through untouched) and
// values shorter than MIN_SCRUB_LENGTH are skipped because scrubbing them would mangle ordinary text.
import { PassThrough, Transform } from "node:stream";

export const MIN_SCRUB_LENGTH = 8;

const TEXT_TYPES = new Set(["application/json", "application/x-www-form-urlencoded", "application/javascript", "application/x-ndjson", "application/xml"]);

// True for text/*, JSON (incl. +json), form bodies and JavaScript.
export function isScrubbableContentType(contentType) {
  const type = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  if (!type) return false;
  return type.startsWith("text/") || TEXT_TYPES.has(type) || type.endsWith("+json") || type.endsWith("+xml");
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// `map`: Map or object of real value → placeholder token. → a replace function over latin1 text,
// plus the holdback computation, or null when there is nothing worth scrubbing.
function compile(map) {
  const entries = (map instanceof Map ? [...map.entries()] : Object.entries(map || {}))
    .filter(([value, token]) => typeof value === "string" && typeof token === "string" && Buffer.byteLength(value) >= MIN_SCRUB_LENGTH)
    .map(([value, token]) => [Buffer.from(value, "utf8").toString("latin1"), Buffer.from(token, "utf8").toString("latin1")]);
  if (!entries.length) return null;
  entries.sort((a, b) => b[0].length - a[0].length); // longest first so a longer value wins
  const lookup = new Map(entries);
  const re = new RegExp(entries.map(([value]) => escapeRe(value)).join("|"), "g");
  const values = entries.map(([value]) => value);

  // The length of the longest suffix of `s` that is a PROPER prefix of some value.
  function holdback(s) {
    let best = 0;
    for (const value of values) {
      for (let k = Math.min(value.length - 1, s.length); k > best; k -= 1) {
        if (s.charCodeAt(s.length - k) === value.charCodeAt(0) && value.startsWith(s.slice(s.length - k))) {
          best = k;
          break;
        }
      }
    }
    return best;
  }
  return { re, lookup, holdback };
}

// One complete string (a response HEADER value: Location, WWW-Authenticate, a debug header) with
// every value in `map` replaced by its placeholder. Values shorter than MIN_SCRUB_LENGTH are left,
// exactly as in the body scrubber.
export function scrubText(map, text) {
  const plan = compile(map);
  if (!plan || typeof text !== "string" || !text) return text;
  const latin = Buffer.from(text, "utf8").toString("latin1");
  plan.re.lastIndex = 0;
  const out = latin.replace(plan.re, (m) => plan.lookup.get(m));
  return out === latin ? text : Buffer.from(out, "latin1").toString("utf8");
}

// Is this response body scrubbed? Text-like types always; a MISSING content type is treated as
// text (an upstream that omits it must not be a way around the scrub); anything declared binary
// (octet-stream, images, archives) passes through.
export function shouldScrubContentType(contentType) {
  if (contentType === undefined || contentType === null || String(contentType).trim() === "") return true;
  return isScrubbableContentType(contentType);
}

// A Transform that scrubs `map`'s values out of the stream; a PassThrough when the content type is
// not text-like or the map has nothing to scrub. `contentType` undefined means "treat as text".
export function createScrubber(map, contentType) {
  const plan = compile(map);
  if (!plan || (contentType !== undefined && !isScrubbableContentType(contentType))) return new PassThrough();
  const { re, lookup, holdback } = plan;
  let pending = "";

  function scrubOut(text, final) {
    const limit = final ? text.length : text.length - holdback(text);
    let out = "";
    let last = 0;
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m.index >= limit) break;
      out += text.slice(last, m.index) + lookup.get(m[0]);
      last = m.index + m[0].length;
    }
    const cut = Math.max(last, limit);
    out += text.slice(last, cut);
    pending = text.slice(cut);
    return out;
  }

  return new Transform({
    transform(chunk, _encoding, callback) {
      const out = scrubOut(pending + Buffer.from(chunk).toString("latin1"), false);
      callback(null, out ? Buffer.from(out, "latin1") : undefined);
    },
    flush(callback) {
      const out = scrubOut(pending, true);
      callback(null, out ? Buffer.from(out, "latin1") : undefined);
    },
  });
}
