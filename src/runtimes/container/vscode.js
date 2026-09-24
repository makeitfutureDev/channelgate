import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createEditorLease } from "./editor-lease.js";
import { resolveContainerClaudeToken } from "../../gateway/claude-token-relay.js";
import { CONTAINER_CLAUDE_CONFIG_DIR } from "./image-paths.js";

export const VSCODE_AUTH_DIR = "vscode";

// Claude Code's global state lives in $CLAUDE_CONFIG_DIR/.claude.json — the image sets
// CLAUDE_CONFIG_DIR, so ~/.claude.json is never read. Engine turns run headless (`claude -p`), which
// skips first-run onboarding, so a channel's file never records it; the first INTERACTIVE `claude` a
// developer starts over SSH or in VS Code then opens the theme picker and a login-method screen and
// looks signed out, although the relayed token works (a `-p` in the same shell answers). Record
// onboarding as done, and a theme only when none was chosen. Merge, never replace: this file is the
// channel's own Claude state. Unreadable JSON is left exactly as it is. Folder trust is deliberately
// NOT pre-accepted — that is the developer's decision, asked once per folder.
export const CLAUDE_ONBOARDING_FILE = `${CONTAINER_CLAUDE_CONFIG_DIR}/.claude.json`;
export const CLAUDE_ONBOARDING_SEED = `
const fs = require("node:fs");
const path = require("node:path");
const file = process.argv[1];
let config = {};
try { config = JSON.parse(fs.readFileSync(file, "utf8")); }
catch (error) { if (error.code !== "ENOENT") process.exit(0); }
if (!config || typeof config !== "object" || Array.isArray(config)) process.exit(0);
if (config.hasCompletedOnboarding === true && config.theme) process.exit(0);
config.hasCompletedOnboarding = true;
if (!config.theme) config.theme = "dark";
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
const temporary = file + ".cg-" + process.pid;
fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
fs.renameSync(temporary, file);
`;

export function vscodeAttachedContainerUri(container, workDir) {
  const authority = Buffer.from(String(container), "utf8").toString("hex");
  const pathname = String(workDir || "/home/agent").startsWith("/") ? String(workDir || "/home/agent") : `/${workDir}`;
  return `vscode-remote://attached-container+${authority}${encodeURI(pathname)}`;
}

function run(bin, args, { input = "", env = process.env, stdio = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: stdio || (input ? ["pipe", "inherit", "inherit"] : "inherit") });
    child.on("error", reject);
    child.on("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`${bin} ${args[0] || ""} ${signal ? `was killed by ${signal}` : `exited ${code}`}`)));
    if (input) child.stdin.end(input);
  });
}

export async function installVscodeClaudeRelay(target, cliBin, {
  resolveToken = resolveContainerClaudeToken,
  runCommand = run,
} = {}) {
  const relay = await resolveToken();
  if (!relay.token) {
    if (relay.source === "api-key") {
      throw new Error("Claude uses the daemon's API key, which is deliberately not exported to an interactive editor terminal. Sign in to Claude on the host or configure a claude setup-token for VS Code attach.");
    }
    throw new Error(relay.error || "Claude has no login available for the editor container");
  }
  const dir = path.join(target.artifactDir, VSCODE_AUTH_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tokenFile = path.join(dir, "claude-token");
  writeFileSync(tokenFile, relay.token, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  const quoted = `'${tokenFile.replaceAll("'", "'\\''")}'`;
  // CLAUDE_CONFIG_DIR is the image's, but a shell that arrived without the container environment
  // (an older SSH session, `env -i`) would otherwise read ~/.claude.json and look signed out.
  const wrapper = `#!/bin/sh\n: "\${CLAUDE_CONFIG_DIR:=${CONTAINER_CLAUDE_CONFIG_DIR}}"\nexport CLAUDE_CONFIG_DIR\nif [ -z "\${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -r ${quoted} ]; then\n  CLAUDE_CODE_OAUTH_TOKEN="$(cat ${quoted})"\n  export CLAUDE_CODE_OAUTH_TOKEN\nfi\nexec /usr/local/bin/claude "$@"\n`;
  await runCommand(cliBin, ["exec", "-i", target.container.name, "sh", "-c", "umask 077; mkdir -p /home/agent/.local/bin; cat > /home/agent/.local/bin/claude; chmod 700 /home/agent/.local/bin/claude"], { input: wrapper });
  // Best effort: without it the editor still works, it just greets the developer with onboarding.
  try { await runCommand(cliBin, ["exec", target.container.name, "node", "-e", CLAUDE_ONBOARDING_SEED, CLAUDE_ONBOARDING_FILE]); }
  catch { /* never block an attach on Claude's first-run flag */ }
  return { source: relay.source, expiresAt: relay.expiresAt, tokenFile };
}

export function clearVscodeClaudeRelay(target) {
  rmSync(path.join(target.artifactDir, VSCODE_AUTH_DIR, "claude-token"), { force: true });
}

export async function launchVscodeContainer(target, {
  cliBin,
  codeBin = "code",
  runCommand = run,
  resolveToken,
  refreshMs = 20 * 60_000,
  log = console,
} = {}) {
  if (!cliBin) throw new Error("container CLI is unavailable");
  const lease = createEditorLease(target);
  let timer = null;
  let stopping = false;
  let refreshing = Promise.resolve();
  try {
    const auth = await installVscodeClaudeRelay(target, cliBin, { resolveToken, runCommand });
    const refresh = () => {
      refreshing = refreshing.then(async () => {
        if (stopping) return;
        try { await installVscodeClaudeRelay(target, cliBin, { resolveToken, runCommand }); }
        catch (error) { log.warn?.(`[vscode] Claude login refresh failed: ${error?.message || error}`); }
      });
    };
    timer = setInterval(refresh, refreshMs);
    timer.unref?.();
    const uri = vscodeAttachedContainerUri(target.container.name, target.workDir);
    await runCommand(codeBin, ["--wait", "--folder-uri", uri]);
    return { uri, auth };
  } finally {
    stopping = true;
    if (timer) clearInterval(timer);
    await refreshing;
    clearVscodeClaudeRelay(target);
    lease.release();
  }
}
