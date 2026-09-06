import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createEditorLease } from "./editor-lease.js";
import { resolveContainerClaudeToken } from "../../gateway/claude-token-relay.js";

export const VSCODE_AUTH_DIR = "vscode";

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
  const wrapper = `#!/bin/sh\nif [ -z "\${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -r ${quoted} ]; then\n  CLAUDE_CODE_OAUTH_TOKEN="$(cat ${quoted})"\n  export CLAUDE_CODE_OAUTH_TOKEN\nfi\nexec /usr/local/bin/claude "$@"\n`;
  await runCommand(cliBin, ["exec", "-i", target.container.name, "sh", "-c", "umask 077; mkdir -p /home/agent/.local/bin; cat > /home/agent/.local/bin/claude; chmod 700 /home/agent/.local/bin/claude"], { input: wrapper });
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
