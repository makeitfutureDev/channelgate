// The engine state used by a direct-host `/sudo` turn. These are the CLI's native host locations,
// not ChannelGate's container relay homes: direct host execution deliberately uses the daemon
// account's real environment and must resume the sessions that its real CLIs write there.
import os from "node:os";
import path from "node:path";

export function hostClaudeStateDir(env = process.env) {
  return path.resolve(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
}

export function hostCodexStateDir(env = process.env) {
  return path.resolve(env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}
