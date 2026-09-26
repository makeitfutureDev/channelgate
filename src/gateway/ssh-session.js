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
//   • the run environment (`resolveEgressRunEnv` + `safeSpawnEnv`, the resolver a turn uses):
//     organization, personal and channel secrets, exactly the names a turn is told about — sourced
//     by the `claude` wrapper, so they reach Claude's tools like they reach a turn's. Where the
//     egress proxy is the container's network (container-secrets P3) every ruled name is its
//     PLACEHOLDER, swapped for the real value only by the daemon's proxy on that secret's hosts, so
//     a shell in the box reads nothing worth copying; an unruled name stays raw and is flagged, or
//     is withheld in strict mode — exactly as in a turn. The proxy/CA environment itself leads the
//     file, so `. "$CG_SESSION_ENV"` re-asserts it over anything a shell changed;
//   • Claude's login as an ACCESS-ONLY credentials file in the channel's config dir plus the
//     operator's account record. Claude Code cannot tell which plan a token in the environment
//     belongs to and labels it "Claude API" with no usage and a lesser default model; a file login
//     shows the plan, the organization, the usage windows and the plan's default model. The file
//     never holds a refresh token, so it cannot rotate anything or sign the operator out — the one
//     hazard the "never copy a credentials file" rule exists for (claude-token-relay.js) — and under
//     the egress proxy its access token is the channel's relay PLACEHOLDER (the plan facts beside
//     it are the real login's; they are not secrets). Claude re-reads it on every request, so the
//     20-minute refresh keeps a long session signed in.
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
import { safeSpawnEnv } from "../config/channel-env.js";
import { requireAdapter } from "../engines/registry.js";
import { CONTAINER_CLAUDE_CONFIG_DIR, CONTAINER_EGRESS_CA, CONTAINER_EGRESS_PORT } from "../runtimes/container/image-paths.js";
import { EGRESS_UNSET_ENV_NAMES } from "../runtimes/container/egress-env.js";
import { egressActive } from "../runtimes/container/egress-hook.js";
import { installVscodeClaudeRelay, installSshCodexWrapper, clearVscodeClaudeRelay, CLAUDE_ONBOARDING_FILE, sshUsersDirOf } from "../runtimes/container/vscode.js";
import { containerClaudeCredential, resolveEgressRunEnv } from "./egress/grants.js";
import { buildCodexArgs, codexSecretBundle, headerHelperSource } from "../engines/codex.js";
import { isIsolatedTarget } from "../engines/runtime-target.js";
import { listEngineMcps, codexMcpPolicyFor } from "./mcp-discovery.js";
import { readDaemonClaudeAccount } from "./claude-token-relay.js";
import { buildSettings } from "./folders.js";
import { buildEngineMcpRuntime } from "./run-engine-mcp.js";
import { resolveRunIntegrations } from "./run-integrations.js";
import { SSH_TOOLSET } from "../mcp/gateway-server.js";
import { containerSshDir, EGRESS_CONNECT_HELPER, sessionEgressEnv } from "./ssh-access.js";
import { clearRemoteMcpsWhere, releaseRemoteMcps } from "../mcp/remote-mcp-registry.js";

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

// The relay registrations (src/mcp/remote-mcp-registry.js) the CURRENT preparation of each
// developer's session files took, per channel + developer — the Claude and the Codex capability.
// A refresh releases the previous preparation's holds: the grant then goes as soon as no relay
// connection holds it, so a `claude` the developer already started keeps the servers it started
// with (the broker's contract: a running process keeps what it started with) while an unused
// grant does not linger for its 12 hours. The session's end drops every grant it minted outright.
const sessionRelayJtis = new Map();
const relayKey = (slug, userId) => `${slug}\u0000${userId}`;
function adoptSessionRelays(slug, userId, jtis) {
  const key = relayKey(slug, userId);
  for (const jti of sessionRelayJtis.get(key) || []) releaseRemoteMcps(jti);
  if (jtis.length) sessionRelayJtis.set(key, jtis);
  else sessionRelayJtis.delete(key);
}

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

/**
 * `export NAME='value'` lines a POSIX shell can source; every value single-quoted, newlines
 * included. `egress` (the session's proxy/CA map, ssh-access.js sessionEgressEnv) leads the file,
 * after an `unset` of the names the proxy env removes, and wins over a same-named entry in `env`.
 */
export function renderSessionEnvFile(env = {}, { egress = {} } = {}) {
  const lines = ["# Generated by ChannelGate — this session's run environment; sourced by the claude wrapper."];
  const valid = (name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  const proxyNames = Object.keys(egress).filter(valid).sort();
  if (proxyNames.length) {
    lines.push("# The egress proxy: this container's only network (re-asserted whenever this file is sourced).");
    lines.push(`unset ${EGRESS_UNSET_ENV_NAMES.join(" ")}`);
    for (const name of proxyNames) lines.push(`export ${name}=${quote(egress[name])}`);
  }
  for (const name of Object.keys(env).sort()) {
    if (!valid(name) || Object.hasOwn(egress, name)) continue;
    lines.push(`export ${name}=${quote(env[name])}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * What only an SSH session's model needs to know, appended to its system prompt by the wrapper
 * (`--append-system-prompt-file`) — never part of every channel's managed block, whose 4 KB budget
 * is for the rules every run shares. Named facts only; no value ever rides here.
 */
export function renderSessionNote({ slug, userId, envFile, egress = null }) {
  const lines = [
    `This is an interactive SSH session in channel \`${slug}\`, prepared by the gateway for <@${userId}> exactly like one of that channel's chat turns: the channel's tool policy, its MCP servers (\`gateway\`, \`composio-user\` = this developer's own accounts, \`composio-agent\` = the channel's) and its secrets as environment variables.`,
    `Secrets change while a session is open. \`list_secrets\` is live, but a process keeps the environment it started with — this one included. The session's CURRENT environment is rewritten within a moment of any change at \`${envFile}\` (also \`$CG_SESSION_ENV\`). When a command needs a credential added after this process started, source that file in the SAME command: \`. "$CG_SESSION_ENV"; <command>\`. Never print a value; refer to secrets by name. A newly selected MCP server needs a new \`claude\`.`,
  ];
  if (egress?.active) {
    // Names and rules only — never a value, never a placeholder string.
    lines.push(
      `This container has no network of its own: everything goes out through the gateway's egress proxy (\`HTTPS_PROXY=http://127.0.0.1:${CONTAINER_EGRESS_PORT}\`, CA bundle \`${CONTAINER_EGRESS_CA}\`), already set in this session's environment. The channel's Allow network switch is enforced there. Protected secrets${egress.protected?.length ? ` (${egress.protected.map((name) => `\`${name}\``).join(", ")})` : ""} hold PLACEHOLDERS (\`cgph_…\`) that only work from this container through that proxy, on each secret's declared hosts: use them exactly like the real credential — the proxy swaps them in flight — and know that \`printenv\` shows nothing worth copying.`,
      "Personal secrets (this developer's own) are swapped only while their owner is working here and NO other person has an SSH session open in this channel; while one is, they are paused and the proxy answers 403 `another-person-ssh-session`. Do not retry or substitute another credential — say so.",
      `Outbound SSH has no route either: \`git\` over SSH already goes through \`${EGRESS_CONNECT_HELPER}\` (GIT_SSH_COMMAND; github.com:22, and only with Allow network on); for another \`ssh\` pass \`-o ProxyCommand='${EGRESS_CONNECT_HELPER} %h %p'\`. The proxy cannot add an SSH key.`,
    );
    if (egress.personalPaused) lines.push("Right now another person has an SSH session open in this channel, so this developer's personal secrets are PAUSED.");
    if (egress.unprotected?.length) lines.push(`Unprotected (the RAW value is in the environment — no egress rule declares where it may be used): ${JSON.stringify(egress.unprotected)}.`);
    if (egress.withheld?.length) lines.push(`Withheld by the gateway's strict egress setting (not in the environment at all): ${JSON.stringify(egress.withheld)}.`);
  }
  lines.push("There is no chat thread behind this session: no background jobs, progress or approval cards; the developer answers your prompts in this terminal.", "");
  return lines.join("\n");
}

function writePrivate(file, body) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, body, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

// The access-only login file: the relayed token — under the egress proxy the channel's relay
// PLACEHOLDER (containerClaudeCredential) — and the real login's plan facts, never a refresh token.
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

// VS Code Remote-SSH opens an empty window in the container's HOME, and its Open Folder dialog and
// terminal start there, so a developer had to climb out of /home/agent to reach the channel folder
// (QA-0925). `files.dialog.defaultPath` in the REMOTE machine settings is what that dialog starts in
// when the window has no recent folder. Merge-only: the file is the channel's own VS Code state
// (VS Code writes to it too), a sidecar remembers the value WE wrote so a changed work folder moves
// it, and a value the developer set themselves — or a file that is not plain JSON — is left alone.
// argv[1] = settings file, argv[2] = sidecar, argv[3] = the channel work folder.
export const VSCODE_MACHINE_SETTINGS = "/home/agent/.vscode-server/data/Machine/settings.json";
export const VSCODE_FOLDER_SEED = `
const fs = require("node:fs");
const path = require("node:path");
const [file, sidecar, folder] = process.argv.slice(1);
const key = "files.dialog.defaultPath";
let config = {};
try { config = JSON.parse(fs.readFileSync(file, "utf8")); }
catch (error) { if (error.code !== "ENOENT") process.exit(0); }
if (!config || typeof config !== "object" || Array.isArray(config)) process.exit(0);
let ours = "";
try { ours = fs.readFileSync(sidecar, "utf8").trim(); } catch {}
const current = config[key];
if (current !== undefined && current !== ours) process.exit(0);
if (current === folder && ours === folder) process.exit(0);
config[key] = folder;
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
const temporary = file + ".cg-" + process.pid;
fs.writeFileSync(temporary, JSON.stringify(config, null, "\\t") + "\\n", { mode: 0o600 });
fs.renameSync(temporary, file);
fs.writeFileSync(sidecar, folder + "\\n", { mode: 0o600 });
`;

// Codex's half of a prepared session (codex-args.sh + its bundle, in the developer's 0700 dir):
// exactly the `-c mcp_servers.*` / `apps.*` overrides a chat turn's Codex gets, with the gateway
// capability in a 0600 bundle — never in argv. The Composio/toolbox servers are relayed by the
// daemon (the `remote-mcp` socket service) exactly as in a turn, so the bundle holds the capability
// and nothing else, no headers helper is written, and the relay registration made when the
// capability was minted lives as long as the capability (SSH_CAPABILITY_TTL_MS); a refresh mints a
// fresh jti and registers again, the old one simply expires. The sandbox, approval and model flags of a turn are NOT carried: the
// developer drives an interactive Codex and answers its prompts themselves.
export function renderCodexArgsScript(overrides) {
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  const pairs = overrides.map((value) => `-c ${quote(value)}`).join(" ");
  return `# Generated by ChannelGate — this SSH session's Codex MCP overrides; sourced by the codex wrapper.\nset -- ${pairs} "$@"\n`;
}
export function codexSessionOverrides(args) {
  const out = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== "-c") continue;
    const value = String(args[i + 1]);
    if (value.startsWith("mcp_servers.") || value.startsWith("apps.")) out.push(value);
  }
  return out;
}

async function prepareCodexSessionFiles({ target, userDir, integrations, meta, clean, entry, user, threadKey, now, buildMcpRuntime, listMcps, cliBin, runCommand, installWrapper }) {
  const allowed = meta[requireAdapter("codex").mcpMetaKey] || [];
  // Minted for Codex: the capability names the engine that holds it.
  const runtime = await buildMcpRuntime({
    clean, engine: "codex", target, allowedMcps: allowed, pluginRuntime: null, fingerprintNow: now(),
    composioUserEndpoint: integrations.composioUserEndpoint, composioEndpoint: integrations.composioEndpoint,
    composioUserToken: integrations.composioUserToken, composioToken: integrations.composioToken,
    toolboxToken: integrations.toolboxToken, makeToolboxUrl: integrations.makeToolboxUrl, makeToolboxKey: integrations.makeToolboxKey,
    channelId: entry.channelId, slug: entry.slug, authorId: user.id, threadKey, origin: SSH_SESSION_ORIGIN,
    progressReport: false, principalTrusted: true,
    gatewayFsRoot: allowedFsRoot(), gatewayWorkspaceRoot: workspaceRoot(),
    toolset: SSH_TOOLSET, ttlMs: SSH_CAPABILITY_TTL_MS,
  });
  const policy = codexMcpPolicyFor(await listMcps(), allowed);
  for (const server of policy.servers) if (server.enabled && !server.definition) server.enabled = false;
  const gatewayCapability = runtime.gatewayCapability || "";
  const bundle = codexSecretBundle({
    isolated: isIsolatedTarget(target),
    gatewayCapability,
    composioUserToken: integrations.composioUserToken || "",
    composioToken: integrations.composioToken || "",
    toolboxToken: integrations.toolboxToken || "",
    makeToolboxKey: integrations.makeToolboxKey || "",
  });
  const secretBundlePath = !clean && Object.values(bundle).some(Boolean) ? path.join(userDir, "codex-secrets.json") : "";
  if (secretBundlePath) writePrivate(secretBundlePath, JSON.stringify(bundle));
  else rmSync(path.join(userDir, "codex-secrets.json"), { force: true }); // Lean: no stale tokens
  const headerHelpers = [];
  const args = buildCodexArgs({
    prompt: "", sessionId: "", isNewSession: true, cwd: target.workDir || "/", dangerouslySkip: false, writable: true, clean,
    composioUserEndpoint: integrations.composioUserEndpoint, composioEndpoint: integrations.composioEndpoint,
    composioUserToken: integrations.composioUserToken, composioToken: integrations.composioToken,
    toolboxToken: integrations.toolboxToken, makeToolboxUrl: integrations.makeToolboxUrl, makeToolboxKey: integrations.makeToolboxKey,
    secretBundlePath, codexMcpPolicy: policy, gatewayCapability, gatewayFsRoot: allowedFsRoot(), gatewayWorkspaceRoot: workspaceRoot(),
    target, outFile: "/dev/null", headerHelpers,
  });
  for (const spec of headerHelpers) {
    writeFileSync(spec.path, headerHelperSource({ ...spec, bundlePath: secretBundlePath }), { mode: 0o700 });
    chmodSync(spec.path, 0o700);
  }
  const overrides = codexSessionOverrides(args);
  writePrivate(path.join(userDir, "codex-args.sh"), renderCodexArgsScript(overrides));
  await installWrapper(target, cliBin, runCommand ? { runCommand: (bin, a, o) => runCommand(a, o) } : {});
  const servers = [...new Set(overrides.filter((v) => v.startsWith("mcp_servers.")).map((v) => v.split(".")[1]))];
  return { ready: true, mcpServers: servers.sort(), reason: "", relayJti: runtime.relayJti || "" };
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
  resolveEnv = resolveEgressRunEnv,
  buildLockdown = buildSettings,
  readAccount = readDaemonClaudeAccount,
  now = Date.now,
  listCodexMcps = () => listEngineMcps("codex").catch(() => []),
  installCodexWrapper = installSshCodexWrapper,
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

  // 1. The relay (token file + wrapper + onboarding) — the one step that must succeed. What the
  // container receives is the CONTAINER form of the login: the channel's relay placeholder under
  // the egress proxy (idempotent, so an installer that already converted it is unaffected).
  const relayed = await installRelay(target, cliBin, { usersDir, channelId: entry.channelId, ...(runCommand ? { runCommand } : {}) });
  const relay = relayed.relay?.token ? containerClaudeCredential({ target, relay: relayed.relay, channelId: entry.channelId }) : (relayed.relay || {});
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

  // 2b. VS Code lands in the channel folder, not the container HOME. Best effort: a failure only
  // costs the developer a few clicks, so it is logged and never blocks the session.
  if (target.workDir) {
    try {
      await exec(["exec", target.container.name, "node", "-e", VSCODE_FOLDER_SEED,
        VSCODE_MACHINE_SETTINGS, `${VSCODE_MACHINE_SETTINGS}.cg-default-folder`, String(target.workDir)]);
    } catch (error) {
      log?.warn?.(`[ssh] ${slug}/${user.id}: VS Code start folder not set (${String(error?.message || error).slice(0, 120)})`);
    }
  }

  // 3. The turn-equivalent files: lockdown, MCP payload, run environment.
  const clean = Boolean(meta.cleanMode);
  const adapter = requireAdapter("claude");
  const threadKey = sshSessionThreadKey(user.id);
  // `codex`: Codex gets the same session as Claude (QA-0925: over SSH it had no gateway MCP, no
  // Composio and no secrets). Best effort and separate from `problems`: a Codex failure never costs
  // the developer the Claude session.
  const result = { claude, toolset: SSH_TOOLSET, mcpServers: [], secrets: [], rejectedMcps: [], userDir, problems: [], codex: { ready: false, mcpServers: [], reason: "" } };
  const relayJtis = [];
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
    if (runtime.relayJti) relayJtis.push(runtime.relayJti);
    writePrivate(path.join(userDir, "mcp.json"), runtime.mcpConfigJson);
    result.mcpServers = Object.keys(JSON.parse(runtime.mcpConfigJson).mcpServers || {});
    result.rejectedMcps = runtime.rejectedMcps || [];
    try {
      const { relayJti: codexRelayJti = "", ...codex } = await prepareCodexSessionFiles({ target, userDir, integrations, meta, clean, entry, user, threadKey, now, buildMcpRuntime, listMcps: listCodexMcps, cliBin, runCommand: exec, installWrapper: installCodexWrapper });
      if (codexRelayJti) relayJtis.push(codexRelayJti);
      result.codex = codex;
    } catch (error) {
      result.codex = { ready: false, mcpServers: [], reason: String(error?.message || error).slice(0, 160) };
      for (const name of ["codex-args.sh", "codex-secrets.json"]) rmSync(path.join(userDir, name), { force: true });
      log?.warn?.(`[ssh] ${slug}/${user.id}: Codex session files not prepared — ${result.codex.reason}`);
    }
  } catch (error) {
    result.problems.push(`mcp: ${String(error?.message || error).slice(0, 160)}`);
  }
  try {
    // The resolver a turn uses: placeholders for ruled names when the proxy is this container's
    // network, the real values otherwise (legacy bridge). untrustedPrincipal is false: the broker
    // authenticated this developer's key, so their personal scope applies — and, under the proxy,
    // swaps only while they are here and nobody else has an SSH session open (liveness.js).
    const resolved = await resolveEnv({ meta, channelId: entry.channelId, authorId: user.id, untrustedPrincipal: false, clean, target });
    const safe = safeSpawnEnv(resolved.env || {});
    const scopes = resolved.scopes || {};
    const placeholders = resolved.placeholders || {};
    const egress = sessionEgressEnv(target);
    // Without the account login the token has to ride the environment after all (the wrapper's
    // editor branch is skipped once the session files exist) — the container form, like the file.
    // CG_SESSION_ENV names this very file: it is rewritten within a moment of a change, but a
    // process that already started keeps its environment — so a command that needs a secret
    // added since can source it first (the hard rules tell the model so).
    const sessionEnv = { ...(claude.account || !relay.token ? safe : { ...safe, CLAUDE_CODE_OAUTH_TOKEN: relay.token }), CG_SESSION_ENV: path.join(userDir, "env") };
    writePrivate(path.join(userDir, "env"), renderSessionEnvFile(sessionEnv, { egress }));
    const names = Object.keys(safe).filter((name) => !Object.hasOwn(egress, name)).sort();
    const egressFacts = egressActive(target) ? {
      active: true,
      protected: names.filter((name) => placeholders[name]),
      unprotected: (resolved.unprotected || []).filter((name) => names.includes(name)).sort(),
      withheld: [...(resolved.withheld || [])].sort(),
      personalPaused: Boolean(resolved.personalPaused),
    } : null;
    writePrivate(path.join(userDir, "session.md"), renderSessionNote({ slug, userId: user.id, envFile: path.join(userDir, "env"), egress: egressFacts }));
    // Names, scopes and whether the proxy protects each — never a value or a placeholder.
    result.secrets = names.map((name) => ({ name, scope: scopes[name] || "channel", protected: Boolean(placeholders[name]) }));
    result.egress = egressFacts ? { active: true, unprotected: egressFacts.unprotected, withheld: egressFacts.withheld, personalPaused: egressFacts.personalPaused } : { active: false };
    result.sessionEnvFile = path.join(userDir, "env");
  } catch (error) {
    result.problems.push(`secrets: ${String(error?.message || error).slice(0, 160)}`);
  }
  // An incomplete set must not half-apply: the wrapper's SSH branch needs all three files, so a
  // failed one removes the others and the session runs plain relayed Claude, reported as such.
  if (result.problems.length) {
    rmSync(userDir, { recursive: true, force: true });
    // The files that named these grants are gone, so nothing will ever connect with them.
    for (const jti of relayJtis.splice(0)) releaseRemoteMcps(jti);
    result.codex = { ready: false, mcpServers: [], reason: result.codex.reason || "the session files were not prepared" };
    result.mcpServers = [];
    result.secrets = [];
    log?.warn?.(`[ssh] ${slug}/${user.id}: session files not prepared — ${result.problems.join("; ")}`);
  }
  adoptSessionRelays(slug, user.id, relayJtis);
  return result;
}

/**
 * The developer's last session in the channel ended: drop their files; the channel's last: the
 * login too — the in-container credentials file, the account record, and the host-side editor
 * token file (`<artifact>/vscode/claude-token`, which the container can read through its mount).
 */
export async function releaseSshSession({ target, entry = null, user, cliBin, lastForUser = true, lastInChannel = false, log = console }, { runCommand = null, clearEditorToken = clearVscodeClaudeRelay } = {}) {
  if (lastForUser) {
    try { rmSync(sshUserDir(target, user.id), { recursive: true, force: true }); } catch { /* already gone */ }
    // The developer's last session here ended: every relay grant any of its preparations minted
    // goes NOW, held or not — a process that outlived the session loses its relayed servers.
    const slug = entry?.slug || target.slug || "";
    sessionRelayJtis.delete(relayKey(slug, user.id));
    clearRemoteMcpsWhere((meta) => meta.origin === SSH_SESSION_ORIGIN && meta.slug === slug && meta.authorId === user.id);
  }
  if (!lastInChannel) return;
  // First, and host-side: it needs no container, so a container that is already gone still loses it.
  try { clearEditorToken(target); } catch (error) { log?.log?.(`[ssh] ${target.slug}: editor token cleanup failed (${String(error?.message || error).slice(0, 120)})`); }
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
