// Read an explicitly requested native Codex credential without logging its contents. Production
// health/cooldown callers set daemonOnly: service API keys are known, while a native channel
// login is deliberately unknown on the host and is validated by the CLI inside that container.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CODEX_LOGIN_HINT = "authenticate Codex inside the channel container or set OPENAI_API_KEY for the daemon";

// Where the CLI would look, in the order the gateway resolves it: the stable engine home it
// spawns with (CODEX_HOME), then the host state dir that gets symlinked into it on the next run.
// Checking only the engine home would report "not signed in" on a fresh install whose first Codex
// run — the one that plants the link — hasn't happened yet.
export function codexAuthCandidates({ codexHome = "", hostCodexHome = "", env = process.env } = {}) {
  const host = String(hostCodexHome || env?.CODEX_HOME || path.join(os.homedir(), ".codex")).trim();
  const candidates = [];
  for (const dir of [String(codexHome || "").trim(), host]) {
    if (!dir) continue;
    const file = path.join(dir, "auth.json");
    if (!candidates.includes(file)) candidates.push(file);
  }
  return candidates;
}

function unknown(detail) {
  return { known: false, authenticated: false, method: "", detail, source: "", fingerprint: "" };
}

// An opaque marker for "this exact credential". Callers never interpret it — they only compare a
// later one with an earlier one to answer "has the credential CHANGED since it broke?". A content
// hash is the honest answer: `codex login` rewrites the file, and so does every successful token
// refresh, while a grant revoked server-side leaves the bytes exactly as they were.
function fingerprintOf(raw) {
  return createHash("sha256").update(String(raw)).digest("hex").slice(0, 16);
}

function credentialFrom(parsed, source, fingerprint) {
  if (typeof parsed?.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.trim()) {
    return { known: true, authenticated: true, method: "api-key", detail: `API key in ${source}`, source, fingerprint };
  }
  const tokens = parsed?.tokens;
  if (tokens && typeof tokens === "object") {
    // A refresh token is the durable half of the ChatGPT grant; the access token it mints expires
    // hourly by design, so an expired access token is NOT evidence of a logged-out host.
    const refresh = typeof tokens.refresh_token === "string" ? tokens.refresh_token.trim() : "";
    const access = typeof tokens.access_token === "string" ? tokens.access_token.trim() : "";
    if (refresh || access) {
      return { known: true, authenticated: true, method: "chatgpt", detail: `ChatGPT sign-in in ${source}`, source, fingerprint };
    }
    return { known: true, authenticated: false, method: "", detail: `${source} holds no usable token — ${CODEX_LOGIN_HINT}`, source, fingerprint };
  }
  // `codex logout` leaves the file behind with its credential fields nulled out. That shape is a
  // positive "logged out", not an unrecognized file.
  if (parsed && typeof parsed === "object" && ("OPENAI_API_KEY" in parsed || "tokens" in parsed)) {
    return { known: true, authenticated: false, method: "", detail: `${source} holds no credential — ${CODEX_LOGIN_HINT}`, source, fingerprint };
  }
  return unknown(`${source} has no recognizable Codex credential fields`);
}

// → { known, authenticated, method, detail, source, fingerprint }. `known:false` means "could not
// tell" and must never block a run or fail a health check.
export async function readCodexAuthState({ codexHome = "", hostCodexHome = "", env = process.env, readFileImpl = readFile, daemonOnly = false } = {}) {
  const apiKey = String(env?.CODEX_API_KEY || env?.OPENAI_API_KEY || "").trim();
  if (apiKey) return { known: true, authenticated: true, method: "api-key", detail: "a service API key is set in the daemon environment", source: "env", fingerprint: fingerprintOf(apiKey) };

  if (daemonOnly) return unknown("Codex authentication is channel-owned; inspect the CLI inside the channel container");
  const candidates = codexAuthCandidates({ codexHome, hostCodexHome, env });
  const missing = [];
  for (const file of candidates) {
    let raw;
    try {
      raw = await readFileImpl(file, "utf8");
    } catch (error) {
      // ENOENT also covers a dangling symlink — the engine home links to a host file that was
      // deleted by `codex logout`, which is exactly the state we want to report.
      if (error?.code === "ENOENT") { missing.push(file); continue; }
      return unknown(`could not read ${file}: ${error?.message || error}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return unknown(`${file} is not valid JSON`);
    }
    return credentialFrom(parsed, file, fingerprintOf(raw));
  }
  if (!missing.length) return unknown("no Codex home to inspect");
  return {
    known: true,
    authenticated: false,
    method: "",
    detail: `no credential at ${missing.join(" or ")} — ${CODEX_LOGIN_HINT}`,
    source: "",
    fingerprint: "",
  };
}

// One sentence for a log line, a health payload, or the error that diverts a turn to the other
// harness. Never includes the credential itself — only paths and the login hint.
export function describeCodexAuth(state) {
  if (!state?.known) return `Codex sign-in state unknown (${state?.detail || "no probe result"})`;
  return state.authenticated
    ? `Codex is signed in (${state.detail})`
    : `Codex is not signed in — ${state.detail}`;
}
