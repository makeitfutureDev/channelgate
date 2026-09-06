// Compatibility boundary for existing callers. Subscription token relaying has been removed:
// the CLI receives the daemon's allowlisted service API credential from buildChildEnv.
import { resolveClaudeLogin } from "./claude-login.js";

export async function resolveContainerClaudeToken({ env = process.env, resolveLogin = resolveClaudeLogin } = {}) {
  const login = resolveLogin({ env });
  if (login.kind === "api-key") return { token: "", source: "api-key", expiresAt: 0, login };
  return { token: "", source: "none", expiresAt: 0, login,
    error: login.reason || "Claude requires ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in the daemon environment" };
}

export function claudeTokenFingerprint(credential) {
  return credential ? `${credential.source || ""}|${credential.login?.fingerprint || ""}|0` : "";
}
