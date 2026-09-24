// What an interactive SSH session inside a channel container is given — the SAME things a chat
// turn in that channel gets, prepared by the daemon before the developer's shell starts and
// refreshed while it is open (gateway/ssh-broker.js):
//
//   • the channel lockdown (`buildSettings`, the file every turn passes as --settings), so the
//     tool policy and the MCP allowlist are the channel's, not Claude Code's defaults;
//   • the per-session MCP payload (`buildEngineMcpRuntime`, the same assembler a turn uses): the
//     gateway control server over the socket bridge with a signed capability naming THIS developer
//     and the reduced "ssh" toolset (no thread to report into), `composio-user` for the developer's
//     own accounts, `composio-agent` for the channel's, the toolboxes, the channel's selected
//     catalog servers — and, through --strict-mcp-config, nothing else: not the operator's own
//     claude.ai connectors that a recognised account would otherwise pull in;
//   • the run environment (`resolveRunEnv` + `safeSpawnEnv`): organization, personal and channel
//     secrets, exactly the names a turn is told about — sourced by the `claude` wrapper, so they
//     reach Claude's tools like they reach a turn's (a shell in the box can read them too, as a
//     turn's process can; write-only is a UI property);
//   • Claude's login as an ACCESS-ONLY credentials file in the channel's config dir plus the
//     operator's account record. Claude Code cannot tell which plan a token in the environment
//     belongs to and labels it "Claude API" with no usage and a lesser default model; a file login
//     shows the plan, the organization, the usage windows and the plan's default model. The file
//     never holds a refresh token, so it cannot rotate anything or sign the operator out — the one
//     hazard the "never copy a credentials file" rule exists for (claude-token-relay.js). Claude
//     re-reads it on every request, so the 20-minute refresh keeps a long session signed in.
//
// The files live per DEVELOPER under <artifactDir>/ssh/users/<userId>/ (the wrapper picks the dir
// by CG_SSH_USER, which sshd sets from the developer's key line), and are removed when that
// developer's last session in the channel ends; the login file goes when the channel's last
// session ends. Everyone in a container is one uid, so these are per developer for correctness,
// not secrecy from each other — the same trust class as the box itself (docs/SSH-ACCESS.md).
import path from "node:path";
import { mkdirSync, writeFileSync, chmodSync, renameSync, rmSync } from "node:fs";
import { allowedFsRoot } from "../web/security.js";
import { workspaceRoot } from "../config/paths.js";
import { resolveRunEnv } from "../config/scoped-env.js";
import { safeSpawnEnv } from "../config/channel-env.js";
import { requireAdapter } from "../engines/registry.js";
import { CONTAINER_CLAUDE_CONFIG_DIR } from "../runtimes/container/image-paths.js";
import { installVscodeClaudeRelay, CLAUDE_ONBOARDING_FILE, sshUsersDirOf } from "../runtimes/container/vscode.js";
import { readDaemonClaudeAccount } from "./claude-token-relay.js";
import { buildSettings } from "./folders.js";
import { buildEngineMcpRuntime } from "./run-engine-mcp.js";
import { resolveRunIntegrations } from "./run-integrations.js";
import { SSH_TOOLSET } from "../mcp/gateway-server.js";
import { containerSshDir } from "./ssh-access.js";

export const SSH_SESSION_ORIGIN = "ssh_session";
export const SSH_USERS_SUBDIR = "users";
export const CLAUDE_CREDENTIALS_FILE = `${CONTAINER_CLAUDE_CONFIG_DIR}/.credentials.json`;
// A session's gateway capability outlives a turn's (six hours): a developer's `claude` keeps the
// bridge it started with, so the grant has to cover a working day. Still bounded, still per
// developer, and gone with the files when the session ends.
export const SSH_CAPABILITY_TTL_MS = 12 * 60 * 60 * 1000;

// Merges the operator's account record into Claude's config file (argv[2] = JSON), or removes it
// (argv[2] = "-"). Merge-only, like the onboarding seed: the file is the channel's own state.
export const CLAUDE_ACCOUNT_SEED = `
const fs = require("node:fs");
const path = require("node:path");
const file = process.argv[1];
const record = process.argv[2] === "-" ? null : JSON.parse(process.argv[2]);
let config = {};
try { config = JSON.parse(fs.readFileSync(file, "utf8")); }
catch (error) { if (error.code !== "ENOENT") process.exit(0); }
if (!config || typeof config !== "object" || Array.isArray(config)) process.exit(0);
if (record) { config.oauthAccount = record; config.hasCompletedOnboarding = true; if (!config.theme) config.theme = "dark"; }
else if (Object.hasOwn(config, "oauthAccount")) delete config.oauthAccount;
else process.exit(0);
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
const temporary = file + ".cg-" + process.pid;
fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
fs.renameSync(temporary, file);
`;

export function sshUsersDir(target) {
  const dir = sshUsersDirOf(target);
  if (path.dirname(dir) !== containerSshDir(target)) throw new Error("SSH session files must live beside the channel's sshd files");
  return dir;
}
export function sshUserDir(target, userId) {
  const id = String(userId || "");
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(id)) throw new Error("SSH session: invalid user id");
  return path.join(sshUsersDir(target), id);
}
export function sshSessionThreadKey(userId) {
  return `ssh:${String(userId || "")}`;
}

/** `export NAME='value'` lines a POSIX shell can source; every value single-quoted, newlines included. */
export function renderSessionEnvFile(env = {}) {
  const lines = ["# Generated by ChannelGate — this session's run environment; sourced by the claude wrapper."];
  for (const name of Object.keys(env).sort()) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    lines.push(`export ${name}='${String(env[name]).replaceAll("'", "'\\''")}'`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * What only an SSH session's model needs to know, appended to its system prompt by the wrapper
 * (`--append-system-prompt-file`) — never part of every channel's managed block, whose 4 KB budget
 * is for the rules every run shares. Named facts only; no value ever rides here.
 */
export function renderSessionNote({ slug, userId, envFile }) {
  return [
    `This is an interactive SSH session in channel \`${slug}\`, prepared by the gateway for <@${userId}> exactly like one of that channel's chat turns: the channel's tool policy, its MCP servers (\`gateway\`, \`composio-user\` = this developer's own accounts, \`composio-agent\` = the channel's) and its secrets as environment variables.`,
    `Secrets change while a session is open. \`list_secrets\` is live, but a process keeps the environment it started with — this one included. The session's CURRENT environment is rewritten within a moment of any change at \`${envFile}\` (also \`$CG_SESSION_ENV\`). When a command needs a credential added after this process started, source that file in the SAME command: \`. "$CG_SESSION_ENV"; <command>\`. Never print a value; refer to secrets by name. A newly selected MCP server needs a new \`claude\`.`,
    "There is no chat thread behind this session: no background jobs, progress or approval cards; the developer answers your prompts in this terminal.",
    "",
  ].join("\n");
}

function writePrivate(file, body) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, body, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

// The access-only login file: the relayed token and its plan facts, never a refresh token.
export function renderAccessOnlyCredentials(relay) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: String(relay.token),
      expiresAt: Number(relay.expiresAt) || 0,
      scopes: Array.isArray(relay.scopes) ? relay.scopes : [],
      subscriptionType: String(relay.subscriptionType || ""),
      rateLimitTier: String(relay.rateLimitTier || ""),
    },
  }, null, 2);
}

/**
 * Prepare (or refresh) one developer's session in one channel. Every step past the relay is best
 * effort and REPORTED, never fatal: a session with plain Claude beats no session, and the status
 * line tells the developer what they did not get. Returns what the session has.
 */
export async function prepareSshSession({ target, entry, meta = {}, user, cliBin, log = console }, {
  runCommand = null,
  installRelay = installVscodeClaudeRelay,
  resolveIntegrations = resolveRunIntegrations,
  buildMcpRuntime = buildEngineMcpRuntime,
  resolveEnv = resolveRunEnv,
  buildLockdown = buildSettings,
  readAccount = readDaemonClaudeAccount,
  now = Date.now,
} = {}) {
  const slug = entry.slug;
  const userDir = sshUserDir(target, user.id);
  const usersDir = sshUsersDir(target);
  const exec = async (args, options) => {
    if (runCommand) return runCommand(cliBin, args, options);
    const { spawn } = await import("node:child_process");
    return new Promise((resolve, reject) => {
      const child = spawn(cliBin, args, { stdio: [options?.input ? "pipe" : "ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${args[0]} exited ${code}: ${stderr.trim().slice(0, 200)}`)));
      if (options?.input) child.stdin.end(options.input);
    });
  };

  // 1. The relay (token file + wrapper + onboarding) — the one step that must succeed.
  const relayed = await installRelay(target, cliBin, { usersDir, ...(runCommand ? { runCommand } : {}) });
  const relay = relayed.relay || {};
  const claude = { relayed: true, source: relayed.source || "", reason: "", account: false };

  // 2. The account-shaped login: an access-only credentials file + the operator's account record.
  if (relay.token) {
    try {
      const configDir = path.posix.dirname(CLAUDE_CREDENTIALS_FILE);
      await exec(["exec", "-i", target.container.name, "sh", "-c",
        `umask 077; mkdir -p ${configDir}; cat > ${CLAUDE_CREDENTIALS_FILE}.cg-tmp && mv -f ${CLAUDE_CREDENTIALS_FILE}.cg-tmp ${CLAUDE_CREDENTIALS_FILE}`],
      { input: renderAccessOnlyCredentials(relay) });
      const account = readAccount(relay.login);
      if (account) await exec(["exec", target.container.name, "node", "-e", CLAUDE_ACCOUNT_SEED, CLAUDE_ONBOARDING_FILE, JSON.stringify(account)]);
      claude.account = true;
    } catch (error) {
      claude.reason = `account login not written (${String(error?.message || error).slice(0, 120)}); the relayed token is used instead`;
      log?.warn?.(`[ssh] ${slug}/${user.id}: ${claude.reason}`);
    }
  }

  // 3. The turn-equivalent files: lockdown, MCP payload, run environment.
  const clean = Boolean(meta.cleanMode);
  const adapter = requireAdapter("claude");
  const threadKey = sshSessionThreadKey(user.id);
  const result = { claude, toolset: SSH_TOOLSET, mcpServers: [], secrets: [], rejectedMcps: [], userDir, problems: [] };
  mkdirSync(userDir, { recursive: true, mode: 0o700 });
  chmodSync(userDir, 0o700);
  try {
    const lockdown = await buildLockdown({ ...meta, _slug: slug }, { target });
    writePrivate(path.join(userDir, "settings.json"), `${JSON.stringify(lockdown, null, 2)}\n`);
  } catch (error) {
    result.problems.push(`lockdown: ${String(error?.message || error).slice(0, 160)}`);
  }
  try {
    const integrations = await resolveIntegrations({ meta, channelId: entry.channelId, authorId: user.id, threadKey, clean, untrustedPrincipal: false });
    const runtime = await buildMcpRuntime({
      clean, engine: "claude", target, allowedMcps: meta[adapter.mcpMetaKey] || [], pluginRuntime: null, fingerprintNow: now(),
      composioUserEndpoint: integrations.composioUserEndpoint, composioEndpoint: integrations.composioEndpoint,
      composioUserToken: integrations.composioUserToken, composioToken: integrations.composioToken,
      toolboxToken: integrations.toolboxToken, makeToolboxUrl: integrations.makeToolboxUrl, makeToolboxKey: integrations.makeToolboxKey,
      channelId: entry.channelId, slug, authorId: user.id, threadKey, origin: SSH_SESSION_ORIGIN,
      progressReport: false, principalTrusted: true,
      gatewayFsRoot: allowedFsRoot(), gatewayWorkspaceRoot: workspaceRoot(),
      toolset: SSH_TOOLSET, ttlMs: SSH_CAPABILITY_TTL_MS,
    });
    writePrivate(path.join(userDir, "mcp.json"), runtime.mcpConfigJson);
    result.mcpServers = Object.keys(JSON.parse(runtime.mcpConfigJson).mcpServers || {});
    result.rejectedMcps = runtime.rejectedMcps || [];
  } catch (error) {
    result.problems.push(`mcp: ${String(error?.message || error).slice(0, 160)}`);
  }
  try {
    const { env } = await resolveEnv({ meta, authorId: user.id, untrustedPrincipal: false, clean });
    const safe = safeSpawnEnv(env);
    // Without the account login the token has to ride the environment after all (the wrapper's
    // editor branch is skipped once the session files exist).
    // CG_SESSION_ENV names this very file: it is rewritten within a moment of a change, but a
    // process that already started keeps its environment — so a command that needs a secret
    // added since can source it first (the hard rules tell the model so).
    const sessionEnv = { ...(claude.account || !relay.token ? safe : { ...safe, CLAUDE_CODE_OAUTH_TOKEN: relay.token }), CG_SESSION_ENV: path.join(userDir, "env") };
    writePrivate(path.join(userDir, "env"), renderSessionEnvFile(sessionEnv));
    writePrivate(path.join(userDir, "session.md"), renderSessionNote({ slug, userId: user.id, envFile: path.join(userDir, "env") }));
    result.secrets = Object.keys(safe).sort();
    result.sessionEnvFile = path.join(userDir, "env");
  } catch (error) {
    result.problems.push(`secrets: ${String(error?.message || error).slice(0, 160)}`);
  }
  // An incomplete set must not half-apply: the wrapper's SSH branch needs all three files, so a
  // failed one removes the others and the session runs plain relayed Claude, reported as such.
  if (result.problems.length) {
    rmSync(userDir, { recursive: true, force: true });
    result.mcpServers = [];
    result.secrets = [];
    log?.warn?.(`[ssh] ${slug}/${user.id}: session files not prepared — ${result.problems.join("; ")}`);
  }
  return result;
}

/** The developer's last session in the channel ended: drop their files; the channel's last: the login too. */
export async function releaseSshSession({ target, user, cliBin, lastForUser = true, lastInChannel = false, log = console }, { runCommand = null } = {}) {
  if (lastForUser) {
    try { rmSync(sshUserDir(target, user.id), { recursive: true, force: true }); } catch { /* already gone */ }
  }
  if (!lastInChannel) return;
  const exec = async (args) => {
    if (runCommand) return runCommand(cliBin, args, {});
    const { spawn } = await import("node:child_process");
    return new Promise((resolve, reject) => {
      const child = spawn(cliBin, args, { stdio: "ignore" });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${args[0]} exited ${code}`)));
    });
  };
  try {
    await exec(["exec", target.container.name, "sh", "-c", `rm -f ${CLAUDE_CREDENTIALS_FILE} ${CLAUDE_CREDENTIALS_FILE}.cg-tmp`]);
    await exec(["exec", target.container.name, "node", "-e", CLAUDE_ACCOUNT_SEED, CLAUDE_ONBOARDING_FILE, "-"]);
  } catch (error) {
    // The container may already be gone (stopped, recreated): nothing left to clean.
    log?.log?.(`[ssh] ${target.slug}: login file cleanup skipped (${String(error?.message || error).slice(0, 120)})`);
  }
}
