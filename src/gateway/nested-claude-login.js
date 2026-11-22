// Make an explicitly invoked `claude` child authenticate independently of its parent engine.
// The HOME volume receives only proxy placeholders, never a real access key or refresh token.
import path from "node:path";
import { resolveContainerClaudeToken } from "./claude-token-relay.js";
import { nestedClaudeLoginEnv } from "./egress/grants.js";
import { egressActive } from "../runtimes/container/egress-hook.js";
import { CLAUDE_NESTED_LOGIN_FILE, renderClaudeWrapper, sshUsersDirOf } from "../runtimes/container/vscode.js";
import { isChannelEngineApproved } from "./channel-engines.js";

// This login is the license `claude`. A channel whose approved list leaves it out gets no login
// at all — the file then holds one line that says why — and the egress proxy refuses the
// placeholder an earlier turn left anywhere else (egress/grants.js gatewayClaudeApprovedIn).
export const NESTED_CLAUDE_NOT_APPROVED = "Claude Code is not approved in this channel, so claude is not signed in here. An administrator can change Approved harnesses in the channel settings.";

export async function installNestedClaudeLogin(target, {
  resolveToken = resolveContainerClaudeToken,
  env = process.env,
} = {}) {
  if (!egressActive(target) || !target?.meta?.channelId || typeof target?.runtime?.writeHomeFile !== "function") return false;
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  const approved = isChannelEngineApproved(target.meta, "claude");
  // Not approved: the gateway's login is not even resolved, let alone refreshed, for this channel.
  const loginEnv = approved ? nestedClaudeLoginEnv({ target, relay: await resolveToken(), env }) : {};
  // The wrapper sources this file, so the reason reaches whoever (or whatever tool) ran `claude`.
  const body = approved
    ? Object.entries(loginEnv).map(([name, value]) => `${name}=${quote(value)}\n`).join("")
    : `printf 'claude: %s\\n' ${quote(NESTED_CLAUDE_NOT_APPROVED)} >&2\n`;
  // An empty file removes a previous managed login without touching a developer's own login.
  await target.runtime.writeHomeFile(target, { file: CLAUDE_NESTED_LOGIN_FILE, body });
  await target.runtime.writeHomeFile(target, {
    file: path.posix.join(target.container.home, ".local/bin/claude"), mode: 0o700,
    body: renderClaudeWrapper({ tokenFile: path.join(target.artifactDir, "vscode/claude-token"), usersDir: sshUsersDirOf(target) }),
  });
  return Object.keys(loginEnv).length > 0;
}
