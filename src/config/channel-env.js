// Per-channel environment secrets: the channel's OWN CLI logins.
//
// Without this, every channel shares the daemon's single host-wide login for a given CLI (see
// config/cli-catalog.js — one `~/.supabase`, linked read-only into every run). That is wrong the
// moment two channels are two different projects. A channel's secrets live in its meta and are
// injected as process environment at spawn: never a file the run can read, never shared with
// another channel, and revocable per channel.
//
// WRITE-ONLY BY DESIGN. Every surface returns { name, provider, last4, setBy, setAt } and nothing
// else. There is no reveal path — deliberately not even for admins, and deliberately NOT in
// web/secrets.js (whose whole point is that it resolves a NAMED field to a getter and so can never
// become "read any config key"; a dynamic bag behind it would erode exactly that). A value that
// cannot be read back cannot be copied out of the UI; a lost token is re-issued at the provider.
//
// PROVIDERS. The stored entry is a REFERENCE with a provider, not a bare string, so an external
// vault is a new provider rather than a rewrite. `local` (value in our own store) is the only one
// implemented; see TASKS.md for the enterprise vault item. An unknown provider THROWS at resolve
// time — a run that silently proceeds without a credential looks like a deploy that quietly did
// nothing, which is the failure mode this rule exists to prevent.
import { createHash } from "node:crypto";
import { PASSTHROUGH_ENV_NAMES } from "../engines/child-env.js";

export const MAX_CHANNEL_ENV_VARS = 32;
export const MAX_CHANNEL_ENV_VALUE_BYTES = 16_384;
// Below this length a 4-char tail gives away a third of the secret, so short values show as "set"
// with no tail at all.
export const MIN_MASKABLE_LENGTH = 12;
export const CHANNEL_ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

// Injecting an arbitrary NAME is code execution, not configuration: LD_PRELOAD and
// DYLD_INSERT_LIBRARIES load attacker code into every child, NODE_OPTIONS=--require and BASH_ENV
// do the same one level up, PATH re-points every binary the agent runs, and ANTHROPIC_BASE_URL
// re-points the model itself. The reserved set is therefore part of the security boundary, not
// ergonomics — and it is enforced BOTH here (on write) and at the merge site (on spawn), because
// buildChildEnv's `extra` deliberately wins over everything inherited.
// AGENT_BROWSER_ is here for both halves of the same reason: _EXECUTABLE_PATH, _ARGS and
// _INIT_SCRIPTS choose what runs inside the browser MCP child (which the engine CLI spawns
// OUTSIDE the folder sandbox), and _NAMESPACE picks WHICH channel's browser daemon this run
// attaches to. See gateway/browser-env.js.
const RESERVED_PREFIXES = ["LD_", "DYLD_", "BASH_FUNC_", "XDG_", "CG_", "CLAUDE_", "CODEX_", "ANTHROPIC_", "OPENAI_", "SLACK_", "AGENT_BROWSER_"];
const RESERVED_EXACT = new Set([
  // Anything the daemon itself sets or passes through. One source of truth: child-env.js.
  ...PASSTHROUGH_ENV_NAMES,
  // Interpreter and linker hooks that turn a variable into code.
  "NODE_OPTIONS", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE",
  "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP",
  "RUBYOPT", "RUBYLIB", "PERL5OPT", "PERL5LIB",
  "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "IFS", "PS4", "CDPATH", "PROMPT_COMMAND",
  // Things git and friends will happily execute for you.
  "GIT_SSH", "GIT_SSH_COMMAND", "GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_EDITOR",
  "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_COUNT",
  "PAGER", "EDITOR", "VISUAL",
]);

export function isReservedEnvName(name) {
  const key = String(name || "");
  if (RESERVED_EXACT.has(key)) return true;
  return RESERVED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

// Environment variables are UPPER_SNAKE by universal convention, and every surface that shows one
// (the admin card, the Slack modal, the listing) renders it that way — so a typed `supabase_token`
// is the same variable as `SUPABASE_TOKEN`, not a different one and not an error. Case is folded
// HERE, before validation, so the stored key is canonical no matter which surface wrote it: the
// store therefore keeps its uppercase-only invariant (normalizeChannelEnv / safeSpawnEnv still
// drop anything else) while the human gets what they meant. Nothing else is forgiven — a dash, a
// space or a leading digit is still a refusal, and the reserved check below runs on the CANONICAL
// name so `path` cannot smuggle PATH past it.
export function normalizeEnvName(name) {
  return String(name || "").trim().toUpperCase();
}

// Throws with a message written for a human in a Slack modal, not a stack trace.
export function assertValidEnvName(name) {
  const typed = String(name || "").trim();
  const key = normalizeEnvName(typed);
  if (!key) throw new Error("Give the variable a name.");
  if (!CHANNEL_ENV_NAME_RE.test(key)) {
    // Echo what was TYPED: telling someone that "MY-TOKEN" is invalid when they wrote "my-token"
    // reads like the tool broke it.
    throw new Error(`"${typed}" is not a valid name — use A–Z, 0–9 and underscores, starting with a letter (e.g. SUPABASE_ACCESS_TOKEN).`);
  }
  if (isReservedEnvName(key)) {
    throw new Error(`"${key}" is reserved — the gateway sets it, or it can change what the agent executes. Pick a different name.`);
  }
  return key;
}

export function assertValidEnvValue(value) {
  const text = typeof value === "string" ? value : "";
  if (!text) throw new Error("Give the variable a value.");
  if (Buffer.byteLength(text, "utf8") > MAX_CHANNEL_ENV_VALUE_BYTES) {
    throw new Error(`That value is too large (limit ${MAX_CHANNEL_ENV_VALUE_BYTES} bytes).`);
  }
  // A newline in an env value survives into the child and, far more often than not, means someone
  // pasted a whole `.env` line or a PEM by accident. Refuse rather than store something the CLI
  // will reject in a way nobody can debug from a masked listing.
  if (/[\r\n\0]/.test(text)) throw new Error("That value contains a line break — paste the token only.");
  return text;
}

const PROVIDERS = {
  local: {
    label: "Stored by ChannelGate",
    // What gets persisted for this provider.
    store: ({ value }) => ({ value: assertValidEnvValue(value) }),
    resolve: (entry) => String(entry?.value || ""),
  },
};

// Tolerant read: the meta blob is hand-editable, so anything MALFORMED is dropped rather than
// allowed to break a run. Writes go through the strict assert* helpers instead.
//
// An unrecognised PROVIDER is deliberately not malformed. Dropping it here would hide a real
// variable — written by a newer build, or by a vault-enabled deployment — from the listing AND
// let the run proceed credential-less, which is the one outcome this design refuses. It is kept,
// shown, and thrown on at resolve time.
export function normalizeChannelEnv(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  let count = 0;
  for (const [name, entry] of Object.entries(raw)) {
    if (count >= MAX_CHANNEL_ENV_VARS) break;
    if (!CHANNEL_ENV_NAME_RE.test(name) || isReservedEnvName(name)) continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const provider = String(entry.provider || "local");
    out[name] = {
      provider,
      ...(typeof entry.value === "string" ? { value: entry.value } : {}),
      ...(typeof entry.ref === "string" && entry.ref ? { ref: entry.ref } : {}),
      setBy: String(entry.setBy || ""),
      setAt: Number.isFinite(entry.setAt) ? entry.setAt : 0,
    };
    count += 1;
  }
  return out;
}

function maskValue(value) {
  const text = String(value || "");
  if (!text) return "";
  return text.length >= MIN_MASKABLE_LENGTH ? text.slice(-4) : "";
}

// The ONLY shape any surface may render. No value, no ref (a vault ref names a path that is itself
// worth not publishing), sorted so the list is stable between renders.
export function listChannelEnv(meta = {}) {
  const env = normalizeChannelEnv(meta.env);
  return Object.entries(env)
    .map(([name, entry]) => ({
      name,
      provider: entry.provider,
      // A tail only exists for a provider that stores the value here. Anything else lists as
      // "set, somewhere else" — which is also how an entry this build cannot resolve shows up,
      // rather than vanishing from the admin's view.
      last4: entry.provider === "local" ? maskValue(entry.value) : "",
      resolvable: Object.hasOwn(PROVIDERS, entry.provider),
      setBy: entry.setBy || "",
      setAt: entry.setAt || 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Pure: returns the NEW env map. Add and update are the same operation — a blind overwrite — so
// there is no read-modify-write of the value anywhere, and nothing to leak on the way through.
export function setChannelEnvVar(env, { name, value, provider = "local", ref = "", actor = "", now = Date.now() } = {}) {
  const key = assertValidEnvName(name);
  if (!Object.hasOwn(PROVIDERS, provider)) throw new Error(`Unknown secret provider "${provider}".`);
  const current = normalizeChannelEnv(env);
  if (!Object.hasOwn(current, key) && Object.keys(current).length >= MAX_CHANNEL_ENV_VARS) {
    throw new Error(`This channel already has the maximum of ${MAX_CHANNEL_ENV_VARS} variables.`);
  }
  const stored = PROVIDERS[provider].store({ value, ref });
  return { ...current, [key]: { provider, ...stored, setBy: String(actor || ""), setAt: now } };
}

export function removeChannelEnvVar(env, name) {
  const current = normalizeChannelEnv(env);
  // Same case folding as the write side: stored keys are always uppercase, so a lowercase spelling
  // names the same variable here too.
  const key = normalizeEnvName(name);
  if (!Object.hasOwn(current, key)) throw new Error(`"${key}" is not set on this channel.`);
  const next = { ...current };
  delete next[key];
  return next;
}

// name → value, for the spawn sites. Async because a provider may have to fetch.
export async function resolveChannelEnv(meta = {}) {
  const env = normalizeChannelEnv(meta.env);
  const out = {};
  for (const [name, entry] of Object.entries(env)) {
    const provider = PROVIDERS[entry.provider];
    // Loud, not silent: a variable this build cannot resolve fails the turn with its NAME in the
    // message. Resolving it to "" would hand the run a missing credential and let it report
    // whatever the CLI does with one — usually "success" against an account it never reached.
    if (!provider) throw new Error(`Channel variable ${name} uses secret provider "${entry.provider}", which this build cannot resolve.`);
    const value = await provider.resolve(entry);
    if (value) out[name] = value;
  }
  return out;
}

// Warm Claude processes are reused across turns by a fingerprint of their launch options. A pooled
// process holds the environment it was STARTED with, so without this a rotated secret would keep
// being served by a process still holding the old one. Digest, never the values: the fingerprint is
// a map key that can end up in a debug line.
export function channelEnvFingerprint(resolved = {}) {
  const names = Object.keys(resolved).sort();
  if (names.length === 0) return "";
  const hash = createHash("sha256");
  for (const name of names) hash.update(`${name}\0${resolved[name]}\0`);
  return hash.digest("hex").slice(0, 16);
}

// The merge-site half of the name rule. buildChildEnv's `extra` wins over everything inherited, so
// a reserved name reaching a spawn would silently rewrite the child's PATH/HOME/etc. Validation on
// write is the primary gate; this one exists because a hand-edited store must not be able to
// bypass it.
export function safeSpawnEnv(resolved = {}) {
  const out = {};
  for (const [name, value] of Object.entries(resolved)) {
    if (!CHANNEL_ENV_NAME_RE.test(name) || isReservedEnvName(name)) continue;
    if (typeof value !== "string" || !value) continue;
    out[name] = value;
  }
  return out;
}

// One mutation entry point, so the admin API and the Slack modal cannot drift into two different
// validation stories. Pure — the caller decides how to persist the returned map (atomically, via
// the function form of patchChannelMeta, so two people editing at once can't lose an entry).
export function patchChannelEnv(env, { set = null, remove = "", actor = "", now = Date.now() } = {}) {
  if (set) return setChannelEnvVar(env, { ...set, actor, now });
  if (remove) return removeChannelEnvVar(env, remove);
  throw new Error("Nothing to change.");
}
