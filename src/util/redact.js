const SECRET_PATTERNS = [
  /\b(xox[baprse]-)[A-Za-z0-9-]+/gi, // incl. xoxe- rotation/refresh tokens
  /\b(sk-(?:proj-)?)[A-Za-z0-9_-]{12,}/gi,
  /\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi,
  /([?&](?:token|key|secret|signature)=)[^&\s]+/gi,
  // Composio tokens ride the x-consumer-api-key header and have no recognizable value prefix —
  // redact by name association wherever a header/config object gets stringified into a log.
  /((?:x-consumer-api-key|x-api-key)["']?\s*[:=]\s*["']?)[A-Za-z0-9._~-]+/gi,
  /(hooks\.slack\.com\/services\/)[A-Za-z0-9\/]+/gi, // Slack webhook URLs grant post access
  // Bare JWTs: OAuth access/id tokens (the shape every engine credential store holds) carry no
  // prefix and no header name once a CLI echoes one into an error line.
  /\b(eyJ)[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g,
];

export function redactLogValue(value) {
  let text = typeof value === "string" ? value : value instanceof Error ? value.stack || value.message : String(value);
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "$1[REDACTED]");
  return text;
}

export function installConsoleRedaction(target = console) {
  for (const level of ["log", "warn", "error", "info"]) {
    const original = target[level]?.bind(target);
    if (!original) continue;
    target[level] = (...args) => original(...args.map(redactLogValue));
  }
}

// ── Exact-value redaction ────────────────────────────────────────────────────
// The patterns above redact by SHAPE and by NAME association, which covers the credentials whose
// format we know. A channel's own environment secrets (config/channel-env.js) have no shape we can
// recognise — they are whatever the provider issues — so they are redacted by value instead.
//
// Why this exists at all: the secrets UI is write-only, but write-only in the UI is not write-only
// at runtime. Anyone who can set a secret in a bash/auto channel can also get the agent to
// `printenv` it, and a CLI that fails will happily echo a token into its own error line. This
// closes the accidental case and the lazy deliberate one; it cannot stop a user who base64s the
// value first, and nothing at this layer could.
// Below this length a "secret" is more likely to be a substring of ordinary prose than the thing
// we meant to hide, and replacing it would mangle the answer to protect nothing. Both forms use
// the same floor so the stream and the final content can never disagree about what was redacted —
// finalize() checks that the streamed text is a prefix of the final content.
export const MIN_REDACTABLE_LENGTH = 8;

export function redactSecretValues(text, values = []) {
  let out = typeof text === "string" ? text : String(text ?? "");
  if (!out) return out;
  // Longest first: a short secret that happens to be a substring of a long one must not carve the
  // long one into pieces that no longer match.
  for (const value of [...new Set(values)].filter((v) => typeof v === "string" && v.length >= MIN_REDACTABLE_LENGTH).sort((a, b) => b.length - a.length)) {
    if (out.includes(value)) out = out.split(value).join("[REDACTED]");
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Streaming form for the delta path. Redacting each chunk independently would miss any value split
// across two chunks — which is the common case, since the model streams a token at a time. Holds
// back ONLY the tail that could still become a match: the longest suffix of the text so far that is
// a proper prefix of some secret. Ordinary prose never begins a credential, so the holdback is
// normally zero and the live reply keeps pace with the model.
//
// It used to hold back a flat (longest secret - 1) characters instead. With a 93-character GitHub
// token in a channel's secrets, every live Slack reply therefore trailed the model by ~92
// characters and only caught up when the run ended — a sentence written just before a tool call
// stayed cut off mid-word for the whole tool run, which read as an answer that had died.
//
// Same algorithm as the egress response scrubber (`gateway/egress/scrub.js`): a match that STARTS
// before the emit boundary is replaced whole even when it reaches past it, so a short secret that
// ends inside a longer secret's pending prefix is never split by the boundary; a complete short
// secret that is itself a prefix of a longer one stays pending until the longer one is decided.
export function createSecretRedactor(values = []) {
  const secrets = [...new Set(values)].filter((v) => typeof v === "string" && v.length >= MIN_REDACTABLE_LENGTH).sort((a, b) => b.length - a.length);
  if (secrets.length === 0) return { push: (chunk) => (typeof chunk === "string" ? chunk : String(chunk ?? "")), flush: () => "" };
  // Longest first in the alternation, so the longer of two overlapping values wins at one index.
  const re = new RegExp(secrets.map(escapeRe).join("|"), "g");
  // The length of the longest suffix of `s` that is a PROPER prefix of some secret.
  const holdback = (s) => {
    let best = 0;
    for (const secret of secrets) {
      for (let k = Math.min(secret.length - 1, s.length); k > best; k -= 1) {
        if (s.charCodeAt(s.length - k) === secret.charCodeAt(0) && secret.startsWith(s.slice(s.length - k))) {
          best = k;
          break;
        }
      }
    }
    return best;
  };
  let pending = "";
  const redactOut = (text, final) => {
    const limit = final ? text.length : text.length - holdback(text);
    let out = "";
    let last = 0;
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m.index >= limit) break;
      out += text.slice(last, m.index) + "[REDACTED]";
      last = m.index + m[0].length;
    }
    const cut = Math.max(last, limit);
    out += text.slice(last, cut);
    pending = text.slice(cut);
    return out;
  };
  return {
    push(chunk) {
      return redactOut(pending + (typeof chunk === "string" ? chunk : String(chunk ?? "")), false);
    },
    flush() {
      const rest = redactOut(pending, true);
      pending = "";
      return rest;
    },
  };
}

// Event payloads and provider-error details can contain the same echoed values as reply text.
// Preserve their structure and the original object; redact only strings that can reach a surface.
export function redactSecretFields(value, values = [], seen = new WeakMap()) {
  if (typeof value === "string") return redactSecretValues(value, values);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return value;
  const copy = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(copy, key, { value: redactSecretFields(item, values, seen), enumerable: true, writable: true, configurable: true });
  }
  return copy;
}
