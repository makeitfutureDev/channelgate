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

// Streaming form for the delta path. Redacting each chunk independently would miss any value split
// across two chunks — which is the common case, since the model streams a token at a time. Holds
// back the last (longest secret - 1) characters until they can no longer begin a match.
export function createSecretRedactor(values = []) {
  const secrets = [...new Set(values)].filter((v) => typeof v === "string" && v.length >= MIN_REDACTABLE_LENGTH).sort((a, b) => b.length - a.length);
  if (secrets.length === 0) return { push: (chunk) => (typeof chunk === "string" ? chunk : String(chunk ?? "")), flush: () => "" };
  const carry = secrets[0].length - 1;
  let buffer = "";
  return {
    push(chunk) {
      buffer += typeof chunk === "string" ? chunk : String(chunk ?? "");
      buffer = redactSecretValues(buffer, secrets);
      if (buffer.length <= carry) return "";
      const emit = buffer.slice(0, buffer.length - carry);
      buffer = buffer.slice(buffer.length - carry);
      return emit;
    },
    flush() {
      const rest = redactSecretValues(buffer, secrets);
      buffer = "";
      return rest;
    },
  };
}
