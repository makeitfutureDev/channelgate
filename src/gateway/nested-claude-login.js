// Make an explicitly invoked `claude` child authenticate independently of its parent engine.
// The HOME volume receives only proxy placeholders, never a real access key or refresh token.
import path from "node:path";
import { resolveContainerClaudeToken } from "./claude-token-relay.js";
import { nestedClaudeLoginEnv } from "./egress/grants.js";
import { egressActive } from "../runtimes/container/egress-hook.js";
import { CLAUDE_NESTED_LOGIN_FILE, renderClaudeWrapper, sshUsersDirOf } from "../runtimes/container/vscode.js";

export async function installNestedClaudeLogin(target, {
  resolveToken = resolveContainerClaudeToken,
  env = process.env,
} = {}) {
  if (!egressActive(target) || !target?.meta?.channelId || typeof target?.runtime?.writeHomeFile !== "function") return false;
  const relay = await resolveToken();
  const loginEnv = nestedClaudeLoginEnv({ target, relay, env });
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  const body = Object.entries(loginEnv).map(([name, value]) => `${name}=${quote(value)}\n`).join("");
  // An empty file removes a previous managed login without touching a developer's own login.
  await target.runtime.writeHomeFile(target, { file: CLAUDE_NESTED_LOGIN_FILE, body });
  await target.runtime.writeHomeFile(target, {
    file: path.posix.join(target.container.home, ".local/bin/claude"), mode: 0o700,
    body: renderClaudeWrapper({ tokenFile: path.join(target.artifactDir, "vscode/claude-token"), usersDir: sshUsersDirOf(target) }),
  });
  return Object.keys(loginEnv).length > 0;
}
