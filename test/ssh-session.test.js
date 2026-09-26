// An interactive SSH session gets what a chat turn gets (gateway/ssh-session.js): the channel
// lockdown, the per-session MCP payload with a signed capability for THIS developer and the "ssh"
// toolset, the run environment, and an account-shaped Claude login without a refresh token.
// Live finding (0.5.3): over SSH, `claude` had no MCP servers, no secrets and looked signed out
// ("Claude API") while a Slack turn in the same channel had all of it.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
const { createFakeRuntime } = await import("./fixtures/fake-runtime-backend.js");
const session = await import("../src/gateway/ssh-session.js");
const { verifyGatewayCapability } = await import("../src/gateway/mcp-capability.js");
const { containerSshDir } = await import("../src/gateway/ssh-access.js");
const { createGatewayMcpServer, ctxFromClaims, SSH_TOOLSET } = await import("../src/mcp/gateway-server.js");
const { RUN_ORIGINS, PRINCIPAL_KIND_BY_ORIGIN } = await import("../src/engines/contract.js");

test.after(() => rmSync(scratch, { recursive: true, force: true }));

const SECRET = process.env.CG_APPROVAL_SECRET;
const runtime = createFakeRuntime();
function target(slug = "ssh-parity") {
  const artifactDir = path.join(scratch, "artifacts", slug);
  mkdirSync(artifactDir, { recursive: true });
  return { ...runtime.backend.prepareTarget({ slug, platform: "slack", artifactDir, workDir: `/work/${slug}` }), container: { name: `cg-${slug}` } };
}
const entry = { slug: "ssh-parity", channelId: "C_SSH_PARITY" };
const user = { id: "U_SSH_DEV", admin: false, approved: true, name: "Dev" };
const relay = { token: "sk-ant-oat01-test-access-token", expiresAt: 1_800_000_000_000, scopes: ["user:inference"], subscriptionType: "max", rateLimitTier: "default_claude_max_20x", login: { home: "/h", configDir: "/h/.claude" } };

function fakes({ relayOk = true, lockdownFails = false, account = { emailAddress: "op@example.com", organizationName: "Op's Org" } } = {}) {
  const execs = [];
  const resolveCalls = [];
  const runCommand = async (bin, args, options = {}) => {
    execs.push({ bin, args, input: options.input || "" });
    if (!relayOk && args.includes("sh") && String(args.at(-1)).includes(".credentials.json")) throw new Error("exec failed");
  };
  return {
    execs,
    resolveCalls,
    deps: {
      runCommand,
      installRelay: async (_target, _cli, opts) => { execs.push({ bin: "relay", args: [opts.usersDir], input: "" }); return { source: "operator", expiresAt: relay.expiresAt, relay }; },
      resolveIntegrations: async ({ authorId, threadKey, clean }) => ({
        composioUserToken: clean ? "" : `cu-${authorId}`, composioToken: clean ? "" : "ca-channel", composioUserEndpoint: null, composioEndpoint: null,
        toolboxToken: "", makeToolboxUrl: "", makeToolboxKey: "", threadKey,
      }),
      resolveEnv: async (args) => {
        resolveCalls.push(args);
        const { authorId, clean } = args;
        return clean ? { env: {}, scopes: {} } : { env: { GITHUB_PAT: "it's a 'quoted'\nvalue", MAKE_API: `m-${authorId}`, LD_PRELOAD: "/evil.so" }, scopes: { GITHUB_PAT: "channel", MAKE_API: "personal", LD_PRELOAD: "channel" } };
      },
      buildLockdown: async (meta) => { if (lockdownFails) throw new Error("no lockdown"); return { permissions: { allow: ["Read"], deny: [] }, allowedMcpServers: [{ serverName: "gateway" }], slug: meta._slug }; },
      readAccount: () => account,
      now: () => 1_700_000_000_000,
      listCodexMcps: async () => [],
    },
  };
}

test("the session is prepared like a turn: lockdown, MCP payload signed for THIS developer on the ssh toolset, sourced secrets, account login without a refresh token", async () => {
  const t = target();
  const { execs, deps, resolveCalls } = fakes();
  const result = await session.prepareSshSession({ target: t, entry, meta: { allowedMcps: [] }, user, cliBin: "podman", log: { warn() {} } }, deps);
  assert.deepEqual(result.claude, { relayed: true, source: "operator", reason: "", account: true });
  assert.equal(result.toolset, SSH_TOOLSET);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.mcpServers.sort(), ["composio-agent", "composio-user", "gateway"]);
  // Names, scopes and protection — never a value (container-secrets P3). Without the egress proxy
  // (this target has no plan) nothing is protected.
  assert.deepEqual(result.secrets, [
    { name: "GITHUB_PAT", scope: "channel", protected: false },
    { name: "MAKE_API", scope: "personal", protected: false },
  ], "reserved names are filtered like a turn's (safeSpawnEnv)");
  assert.deepEqual(result.egress, { active: false });
  // The env is resolved by the SAME resolver a turn uses, for this channel, this developer as a
  // trusted principal, and this target (which decides placeholders vs raw).
  assert.equal(resolveCalls.length, 1);
  assert.deepEqual({ ...resolveCalls[0], target: resolveCalls[0].target === t }, { meta: { allowedMcps: [] }, channelId: entry.channelId, authorId: user.id, untrustedPrincipal: false, clean: false, target: true });
  const dir = session.sshUserDir(t, user.id);
  assert.equal(dir, path.join(containerSshDir(t), "users", user.id), "beside the channel's sshd files, per developer");
  for (const name of ["mcp.json", "settings.json", "env", "session.md"]) assert.equal(statSync(path.join(dir, name)).mode & 0o777, 0o600, name);
  const note = readFileSync(path.join(dir, "session.md"), "utf8");
  assert.ok(note.includes(`. "$CG_SESSION_ENV"; <command>`) && note.includes(`<@${user.id}>`) && note.includes(entry.slug), "the session's own system-prompt note: source the current env file for a credential added since");
  assert.ok(!note.includes("m-U_SSH_DEV") && !note.includes("quoted"), "names, never values");
  assert.doesNotMatch(note, /egress proxy|placeholder/i, "no proxy paragraph where the proxy is not this container's network");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  // The lockdown is the channel's own.
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8")).slug, entry.slug);
  // The MCP payload: the gateway control server over the image bridge with a capability naming the
  // developer, the ssh toolset, the ssh_session origin and a session-length TTL.
  const mcp = JSON.parse(readFileSync(path.join(dir, "mcp.json"), "utf8")).mcpServers;
  assert.equal(mcp.gateway.env.CG_TOOLSET, SSH_TOOLSET);
  const verified = verifyGatewayCapability(mcp.gateway.env.CG_GATEWAY_CAPABILITY, { secret: SECRET });
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(verified.claims.authorId, user.id);
  assert.equal(verified.claims.threadKey, session.sshSessionThreadKey(user.id));
  assert.equal(verified.claims.origin, session.SSH_SESSION_ORIGIN);
  assert.equal(verified.claims.toolset, SSH_TOOLSET);
  assert.equal(verified.claims.exp - verified.claims.iat, session.SSH_CAPABILITY_TTL_MS);
  // Both identities are relayed by the daemon (container-secrets P1): mcp.json lives in the
  // artifact dir every process in the container can read, so it names the servers and carries the
  // capability only; the developer's own token and the channel's are in the daemon's relay
  // registry, under THIS session capability's jti, for the session's 12-hour lifetime.
  const { lookupRemoteMcp } = await import("../src/mcp/remote-mcp-registry.js");
  const mcpText = readFileSync(path.join(dir, "mcp.json"), "utf8");
  assert.ok(!mcpText.includes(`cu-${user.id}`) && !mcpText.includes("ca-channel"), "no Composio credential in the session's mcp.json");
  for (const name of ["composio-user", "composio-agent"]) {
    assert.equal(mcp[name].env.CG_MCP_SERVICE, "remote-mcp", name);
    assert.equal(mcp[name].args.at(-1), name);
    assert.equal(mcp[name].env.CG_GATEWAY_CAPABILITY, mcp.gateway.env.CG_GATEWAY_CAPABILITY);
  }
  assert.deepEqual(verified.claims.remoteMcps, ["composio-user", "composio-agent"]);
  assert.deepEqual(lookupRemoteMcp(verified.claims.jti, "composio-user", verified.claims.iat + 1).headers, { "x-consumer-api-key": `cu-${user.id}` }, "the developer's OWN Composio identity");
  assert.deepEqual(lookupRemoteMcp(verified.claims.jti, "composio-agent", verified.claims.iat + 1).headers, { "x-consumer-api-key": "ca-channel" }, "and the channel's");
  // The env file: every value single-quoted so a POSIX shell reproduces it exactly; no token in it
  // when the account login was written (the file login is what Claude shows as the account).
  const envFile = readFileSync(path.join(dir, "env"), "utf8");
  assert.ok(!envFile.includes("CLAUDE_CODE_OAUTH_TOKEN"), "no token rides the environment when the login file exists");
  assert.ok(!envFile.includes("LD_PRELOAD"));
  assert.ok(envFile.includes(`export CG_SESSION_ENV='${path.join(dir, "env")}'`), "the session names its own env file");
  const echoed = execFileSync("sh", ["-c", `. '${path.join(dir, "env")}'; printf '%s|%s' "$GITHUB_PAT" "$MAKE_API"`], { encoding: "utf8" });
  assert.equal(echoed, `it's a 'quoted'\nvalue|m-${user.id}`);
  // The login: an access-only credentials file written into the channel's config dir, then the
  // operator's account record merged into Claude's config file; the wrapper knows the users dir.
  const creds = execs.find((e) => e.args.includes("sh") && String(e.args.at(-1)).includes(".credentials.json"));
  const written = JSON.parse(creds.input).claudeAiOauth;
  assert.deepEqual(Object.keys(written).sort(), ["accessToken", "expiresAt", "rateLimitTier", "scopes", "subscriptionType"], "never a refresh token");
  assert.equal(written.accessToken, relay.token);
  assert.equal(written.subscriptionType, "max");
  assert.match(creds.args.at(-1), /^umask 077; mkdir -p \/home\/agent\/\.claude; cat > \/home\/agent\/\.claude\/\.credentials\.json\.cg-tmp && mv -f/);
  const seed = execs.find((e) => e.args.includes("node") && e.args.includes(session.CLAUDE_ACCOUNT_SEED));
  assert.equal(seed.args.at(-2), "/home/agent/.claude/.claude.json");
  assert.deepEqual(JSON.parse(seed.args.at(-1)), { emailAddress: "op@example.com", organizationName: "Op's Org" });
  assert.equal(execs[0].bin, "relay");
  assert.equal(execs[0].args[0], session.sshUsersDir(t), "the wrapper is rendered with the users dir so its SSH branch finds the files");
});

test("a Lean channel prepares an empty payload and no secrets, like a Lean turn", async () => {
  const t = target("ssh-lean");
  const { deps } = fakes();
  const result = await session.prepareSshSession({ target: t, entry: { slug: "ssh-lean", channelId: "C_LEAN" }, meta: { cleanMode: true }, user, cliBin: "podman", log: { warn() {} } }, deps);
  assert.deepEqual(result.mcpServers, []);
  assert.deepEqual(result.secrets, []);
  assert.deepEqual(JSON.parse(readFileSync(path.join(session.sshUserDir(t, user.id), "mcp.json"), "utf8")), { mcpServers: {} });
});

test("when the login file cannot be written the token rides the environment instead, reported; when any turn file fails, none is left behind", async () => {
  const t = target("ssh-degraded");
  const e = { slug: "ssh-degraded", channelId: "C_DEG" };
  const noAccount = fakes({ relayOk: false });
  const r1 = await session.prepareSshSession({ target: t, entry: e, meta: {}, user, cliBin: "podman", log: { warn() {} } }, noAccount.deps);
  assert.equal(r1.claude.account, false);
  assert.match(r1.claude.reason, /account login not written/);
  assert.ok(readFileSync(path.join(session.sshUserDir(t, user.id), "env"), "utf8").includes(`export CLAUDE_CODE_OAUTH_TOKEN='${relay.token}'`));
  assert.deepEqual(r1.mcpServers.sort(), ["composio-agent", "composio-user", "gateway"], "the rest of the session is unaffected");
  const broken = fakes({ lockdownFails: true });
  const r2 = await session.prepareSshSession({ target: t, entry: e, meta: {}, user, cliBin: "podman", log: { warn() {} } }, broken.deps);
  assert.match(r2.problems[0], /^lockdown: no lockdown/);
  assert.deepEqual(r2.mcpServers, []);
  assert.deepEqual(r2.secrets, []);
  assert.equal(existsSync(session.sshUserDir(t, user.id)), false, "the wrapper needs all three files, so a partial set is removed");
  assert.equal(r2.claude.account, true, "the login itself still works");
  assert.equal(session.sshUsersDir(t), path.join(containerSshDir(t), "users"));
  assert.throws(() => session.sshUserDir(t, "../escape"), /invalid user id/);
});

test("release: the developer's last session drops their files; the channel's last session removes the login file and the account record", async () => {
  const t = target("ssh-release");
  const { execs, deps } = fakes();
  await session.prepareSshSession({ target: t, entry: { slug: "ssh-release", channelId: "C_REL" }, meta: {}, user, cliBin: "podman", log: { warn() {} } }, deps);
  const dir = session.sshUserDir(t, user.id);
  // The host-side editor token file (vscode.js) — readable through the artifact mount, so it goes
  // with the channel's last session, not only when the VS Code launcher exits.
  const editorToken = path.join(t.artifactDir, "vscode", "claude-token");
  mkdirSync(path.dirname(editorToken), { recursive: true });
  writeFileSync(editorToken, "token");
  execs.length = 0;
  await session.releaseSshSession({ target: t, user, cliBin: "podman", lastForUser: false, lastInChannel: false, log: { log() {} } }, { runCommand: deps.runCommand });
  assert.equal(existsSync(dir), true, "another session of this developer still uses them");
  assert.deepEqual(execs, []);
  await session.releaseSshSession({ target: t, user, cliBin: "podman", lastForUser: true, lastInChannel: false, log: { log() {} } }, { runCommand: deps.runCommand });
  assert.equal(existsSync(dir), false);
  assert.deepEqual(execs, [], "the login stays while other developers are in the channel");
  assert.equal(existsSync(editorToken), true, "and so does the editor token");
  await session.releaseSshSession({ target: t, user, cliBin: "podman", lastForUser: true, lastInChannel: true, log: { log() {} } }, { runCommand: deps.runCommand });
  assert.equal(existsSync(editorToken), false, "the channel's last session removes the editor token file");
  assert.equal(execs.length, 2);
  assert.match(execs[0].args.at(-1), /^rm -f \/home\/agent\/\.claude\/\.credentials\.json /);
  assert.deepEqual(execs[1].args.slice(-2), ["/home/agent/.claude/.claude.json", "-"], "the account record is removed, merge-only");
  // A container that is already gone is not an error — and still loses the host-side token file.
  writeFileSync(editorToken, "token");
  await session.releaseSshSession({ target: t, user, cliBin: "podman", lastForUser: true, lastInChannel: true, log: { log() {} } }, { runCommand: async () => { throw new Error("no such container"); } });
  assert.equal(existsSync(editorToken), false);
});

test("the account seed merges the record and onboarding into Claude's config, removes only the record, and leaves unparseable state alone", () => {
  const dir = mkdtempSync(path.join(scratch, "account-seed-"));
  const file = path.join(dir, "cfg", ".claude.json");
  const seed = (...args) => execFileSync(process.execPath, ["-e", session.CLAUDE_ACCOUNT_SEED, file, ...args], { encoding: "utf8" });
  seed(JSON.stringify({ emailAddress: "op@example.com" }));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { oauthAccount: { emailAddress: "op@example.com" }, hasCompletedOnboarding: true, theme: "dark" });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  writeFileSync(file, JSON.stringify({ theme: "light", projects: { "/w": { allowedTools: ["Bash"] } }, oauthAccount: { emailAddress: "stale@example.com" } }));
  seed(JSON.stringify({ emailAddress: "op@example.com", organizationName: "Org" }));
  const merged = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(merged.oauthAccount, { emailAddress: "op@example.com", organizationName: "Org" }, "a stale record is replaced whole");
  assert.equal(merged.theme, "light", "the developer's own choice stays");
  assert.deepEqual(merged.projects, { "/w": { allowedTools: ["Bash"] } });
  seed("-");
  const removed = JSON.parse(readFileSync(file, "utf8"));
  assert.equal("oauthAccount" in removed, false);
  assert.equal(removed.theme, "light");
  assert.equal(removed.hasCompletedOnboarding, true, "onboarding stays done — the next session must not greet the theme picker");
  const before = readFileSync(file, "utf8");
  seed("-");
  assert.equal(readFileSync(file, "utf8"), before, "nothing to remove: not rewritten");
  writeFileSync(file, "{broken");
  seed(JSON.stringify({ emailAddress: "x" }));
  assert.equal(readFileSync(file, "utf8"), "{broken");
});

test("renderSessionEnvFile: sorted, single-quoted, invalid names dropped; renderAccessOnlyCredentials never carries a refresh token", () => {
  const body = session.renderSessionEnvFile({ B: "1", A: "it's", "bad-name": "x", NL: "a\nb" });
  assert.equal(body, "# Generated by ChannelGate — this session's run environment; sourced by the claude wrapper.\nexport A='it'\\''s'\nexport B='1'\nexport NL='a\nb'\n");
  assert.ok(!body.includes("bad-name"));
  // The egress block leads the file, unsets ALL_PROXY, and wins over a same-named entry.
  const withProxy = session.renderSessionEnvFile({ B: "1", HTTPS_PROXY: "http://evil:1" }, { egress: { HTTPS_PROXY: "http://127.0.0.1:3128", GIT_SSH_COMMAND: "ssh -o ProxyCommand='x %h %p'" } });
  assert.equal(withProxy, "# Generated by ChannelGate — this session's run environment; sourced by the claude wrapper.\n"
    + "# The egress proxy: this container's only network (re-asserted whenever this file is sourced).\n"
    + "unset ALL_PROXY all_proxy\n"
    + "export GIT_SSH_COMMAND='ssh -o ProxyCommand='\\''x %h %p'\\'''\n"
    + "export HTTPS_PROXY='http://127.0.0.1:3128'\n"
    + "export B='1'\n");
  const creds = JSON.parse(session.renderAccessOnlyCredentials({ ...relay, refreshToken: "must-not-leak" }));
  assert.equal("refreshToken" in creds.claudeAiOauth, false);
  assert.equal(creds.claudeAiOauth.accessToken, relay.token);
});

test("the ssh toolset is the control plane minus the thread-bound tools; ssh_session is a user origin", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const names = async (toolset) => {
    const ctx = ctxFromClaims({ channelId: "C_TOOLSET", slug: "toolset", authorId: user.id, threadKey: "ssh:U_SSH_DEV", principalTrusted: true, engine: "claude", toolset }, {
      daemon: { available: () => true, call: async () => ({}) },
    });
    const server = createGatewayMcpServer(ctx);
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    try { return (await client.listTools()).tools.map((tool) => tool.name).sort(); } finally { await client.close(); await server.close(); }
  };
  const full = await names("full");
  const ssh = await names(SSH_TOOLSET);
  const review = await names("memory-review");
  const threadBound = ["run_in_background", "run_agent_in_background", "report_progress", "request_approval", "permission_prompt"];
  for (const name of threadBound) {
    assert.ok(full.includes(name) || name === "report_progress", `${name} is a turn's`);
    assert.ok(!ssh.includes(name), `${name} has no thread to speak into over SSH`);
  }
  for (const name of ["update_channel_memory", "search_channel_memory", "list_schedules", "workspace_read", "list_skills", "show_channel_ssh", "list_secrets"]) {
    assert.ok(ssh.includes(name), `${name} is available over SSH`);
  }
  assert.deepEqual(full.filter((n) => !ssh.includes(n)).sort(), threadBound.filter((n) => full.includes(n)).sort(), "nothing else differs");
  assert.ok(review.length < ssh.length && review.includes("update_channel_memory"), "the reviewer's surface stays the smallest");
  assert.ok(RUN_ORIGINS.includes(session.SSH_SESSION_ORIGIN));
  assert.equal(PRINCIPAL_KIND_BY_ORIGIN[session.SSH_SESSION_ORIGIN], "user");
});

test("VS Code over SSH starts its Open Folder dialog in the channel folder, never over the developer's own choice", () => {
  // QA-0925: Remote-SSH landed in /home/agent and the developer had to climb to the channel folder.
  const dir = mkdtempSync(path.join(scratch, "vscode-seed-"));
  const file = path.join(dir, "Machine", "settings.json");
  const sidecar = `${file}.cg-default-folder`;
  const seed = (folder) => execFileSync(process.execPath, ["-e", session.VSCODE_FOLDER_SEED, file, sidecar, folder]);
  const read = () => JSON.parse(readFileSync(file, "utf8"));
  seed("/home/management/ChannelGate/slack/a");
  assert.equal(read()["files.dialog.defaultPath"], "/home/management/ChannelGate/slack/a", "absent file: created with the folder");
  // VS Code's own entries survive the merge.
  writeFileSync(file, JSON.stringify({ ...read(), "github.copilot.chat.codeGeneration.instructions": [{ text: "x" }] }));
  seed("/home/management/custom-folder");
  assert.equal(read()["files.dialog.defaultPath"], "/home/management/custom-folder", "our value follows a changed work folder");
  assert.deepEqual(read()["github.copilot.chat.codeGeneration.instructions"], [{ text: "x" }]);
  // The developer points it somewhere else: left alone from then on.
  writeFileSync(file, JSON.stringify({ ...read(), "files.dialog.defaultPath": "/home/agent/projects" }));
  seed("/home/management/ChannelGate/slack/a");
  assert.equal(read()["files.dialog.defaultPath"], "/home/agent/projects");
  // A file that is not plain JSON (comments) is never rewritten.
  writeFileSync(file, "// mine\n{}\n");
  seed("/home/management/ChannelGate/slack/a");
  assert.equal(readFileSync(file, "utf8"), "// mine\n{}\n");
});

test("session prep seeds the VS Code start folder with the channel's effective work folder, and a failure never blocks the session", async () => {
  const t = target("ssh-vscode");
  const { execs, deps } = fakes();
  await session.prepareSshSession({ target: t, entry: { slug: "ssh-vscode", channelId: "C_VS" }, meta: {}, user, cliBin: "podman", log: { warn() {} } }, deps);
  const call = execs.find((e) => e.args.includes(session.VSCODE_FOLDER_SEED));
  assert.ok(call, "the seed ran");
  assert.deepEqual(call.args.slice(-3), [session.VSCODE_MACHINE_SETTINGS, `${session.VSCODE_MACHINE_SETTINGS}.cg-default-folder`, "/work/ssh-vscode"]);
  assert.equal(call.args[1], "cg-ssh-vscode", "inside the channel's own container");
  const warnings = [];
  const failing = fakes();
  const runCommand = failing.deps.runCommand;
  failing.deps.runCommand = async (bin, args, options) => { if (args.includes(session.VSCODE_FOLDER_SEED)) throw new Error("exec failed"); return runCommand(bin, args, options); };
  const result = await session.prepareSshSession({ target: target("ssh-vscode-fail"), entry: { slug: "ssh-vscode-fail", channelId: "C_VF" }, meta: {}, user, cliBin: "podman", log: { warn: (m) => warnings.push(m) } }, failing.deps);
  assert.deepEqual(result.problems, [], "the session is still fully prepared");
  assert.ok(warnings.some((m) => m.includes("VS Code start folder not set")));
});

test("Codex over SSH gets the turn's MCP servers from a 0600 bundle, never a credential in the overrides or the bundle", async () => {
  // QA-0925: `codex` in an SSH session had no gateway MCP, no Composio and none of the secrets.
  const t = target("ssh-codex");
  const { execs, deps } = fakes();
  const result = await session.prepareSshSession({ target: t, entry: { slug: "ssh-codex", channelId: "C_CX" }, meta: {}, user, cliBin: "podman", log: { warn() {} } }, deps);
  assert.equal(result.codex.ready, true, result.codex.reason);
  assert.deepEqual(result.codex.mcpServers, ["composio-agent", "composio-user", "gateway"]);
  const dir = session.sshUserDir(t, user.id);
  const argsFile = path.join(dir, "codex-args.sh");
  assert.equal(statSync(argsFile).mode & 0o777, 0o600);
  const script = readFileSync(argsFile, "utf8");
  for (const secret of [`cu-${user.id}`, "ca-channel"]) assert.ok(!script.includes(secret), `${secret} never in the overrides`);
  assert.doesNotMatch(script, /CG_GATEWAY_CAPABILITY=|eyJ/, "the capability rides the bundle, not the overrides");
  const bundle = JSON.parse(readFileSync(path.join(dir, "codex-secrets.json"), "utf8"));
  assert.equal(statSync(path.join(dir, "codex-secrets.json")).mode & 0o777, 0o600);
  // The bundle holds the capability and NOTHING else: Composio is relayed by the daemon, so no
  // token and no headers helper sits in the developer's dir (container-secrets P1).
  assert.deepEqual(Object.keys(bundle), ["gatewayCapability"]);
  const bundleText = readFileSync(path.join(dir, "codex-secrets.json"), "utf8");
  for (const secret of [`cu-${user.id}`, "ca-channel"]) assert.ok(!bundleText.includes(secret), `${secret} never in the bundle`);
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".headers.cjs")), [], "no headers helper is written");
  for (const name of ["composio-user", "composio-agent"]) {
    assert.ok(script.includes(`mcp_servers.${name}.env.CG_MCP_SERVICE="remote-mcp"`), `${name} is relayed`);
  }
  const verified = verifyGatewayCapability(bundle.gatewayCapability, { secret: SECRET });
  assert.equal(verified.ok, true);
  assert.equal(verified.claims.engine, "codex", "minted for the engine that holds it");
  assert.equal(verified.claims.authorId, user.id);
  assert.equal(verified.claims.toolset, SSH_TOOLSET);
  assert.deepEqual(verified.claims.remoteMcps, ["composio-user", "composio-agent"], "the Codex capability is registered for its own relays");
  const { lookupRemoteMcp } = await import("../src/mcp/remote-mcp-registry.js");
  assert.deepEqual(lookupRemoteMcp(verified.claims.jti, "composio-user", verified.claims.iat + 1).headers, { "x-consumer-api-key": `cu-${user.id}` });
  assert.equal(verified.claims.exp - verified.claims.iat, session.SSH_CAPABILITY_TTL_MS, "the relay registration lives as long as the session's capability");
  // Sourcing the script prepends the overrides and keeps the developer's own arguments last.
  const argv = execFileSync("sh", ["-c", `. '${argsFile}'; printf '%s\\n' "$@"`, "sh", "resume", "--last"], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(argv.slice(-2), ["resume", "--last"]);
  assert.ok(argv.includes("mcp_servers.gateway.default_tools_approval_mode=\"approve\""));
  assert.equal(argv.filter((a) => a === "-c").length * 2, argv.length - 2, "every override is one -c pair");
  assert.ok(!argv.some((a) => /approval_policy|sandbox|--dangerously/.test(a)), "no turn-only sandbox/approval flags: the developer answers Codex's own prompts");
  // The wrappers are installed into the channel container.
  const installs = execs.filter((e) => String(e.args.at(-1)).includes("/home/agent/.local/bin/")).map((e) => e.args.at(-1).match(/bin\/([a-z-]+);/)?.[1]).filter(Boolean);
  assert.ok(installs.includes("codex") && installs.includes("with-secrets"), installs.join(","));
});

test("the codex wrapper sources the secrets, applies the overrides and starts in the channel folder", async () => {
  const { renderCodexWrapper, renderWithSecrets } = await import("../src/runtimes/container/vscode.js");
  const root = mkdtempSync(path.join(scratch, "codex-wrapper-"));
  const users = path.join(root, "users"), work = path.join(root, "work"), elsewhere = path.join(root, "elsewhere");
  mkdirSync(path.join(users, "U1"), { recursive: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(path.join(users, "U1", "env"), "export MAKE_API_ADMIN='mk'\n");
  writeFileSync(path.join(users, "U1", "codex-args.sh"), session.renderCodexArgsScript(["mcp_servers.gateway.command=\"node\"", "apps._default.enabled=false"]));
  const fakeCodex = path.join(root, "codex");
  writeFileSync(fakeCodex, "#!/bin/sh\nprintf 'pwd=%s\\n' \"$PWD\"; printf 'secret=%s\\n' \"${MAKE_API_ADMIN:-}\"; for a in \"$@\"; do printf 'arg=%s\\n' \"$a\"; done\n", { mode: 0o755 });
  const wrapper = path.join(root, "wrapper");
  writeFileSync(wrapper, renderCodexWrapper({ usersDir: users, codexBin: fakeCodex }), { mode: 0o755 });
  const run = (envExtra, cwd = elsewhere) => execFileSync(wrapper, ["hello"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, ...envExtra } });
  const out = run({ CG_SSH_USER: "U1", CG_WORKDIR: work, HOME: root }, root);
  assert.match(out, new RegExp(`pwd=${work}\n`), "from HOME (or a parent of the folder) it starts in the channel folder");
  assert.match(run({ CG_SSH_USER: "U1", CG_WORKDIR: work, HOME: "/nonexistent" }, elsewhere), new RegExp(`pwd=${elsewhere}\n`), "anywhere else it stays put: relative paths keep their meaning");
  assert.match(out, /secret=mk/);
  assert.match(out, /arg=-c\narg=mcp_servers\.gateway\.command="node"\narg=-c\narg=apps\._default\.enabled=false\narg=hello/);
  const plain = run({});
  assert.match(plain, new RegExp(`pwd=${elsewhere}`), "outside an SSH session it is the plain CLI");
  assert.match(plain, /secret=\n/);
  assert.doesNotMatch(plain, /arg=-c/);
  // with-secrets runs one command with the same secrets.
  const helper = path.join(root, "with-secrets");
  writeFileSync(helper, renderWithSecrets({ usersDir: users }), { mode: 0o755 });
  assert.equal(execFileSync(helper, ["sh", "-c", "printf %s \"$MAKE_API_ADMIN\""], { encoding: "utf8", env: { PATH: process.env.PATH, CG_SSH_USER: "U1" } }), "mk");
});

test("a refresh releases the previous relay grant unless a running process holds it; the session's end drops them all", async () => {
  const { hasRemoteMcps, retainRemoteMcps } = await import("../src/mcp/remote-mcp-registry.js");
  const t = target("ssh-relay-refresh");
  const sessionEntry = { slug: "ssh-relay-refresh", channelId: "C_RR" };
  const prepare = async () => {
    const { deps } = fakes();
    await session.prepareSshSession({ target: t, entry: sessionEntry, meta: {}, user, cliBin: "podman", log: { warn() {} } }, deps);
    const dir = session.sshUserDir(t, user.id);
    const mcp = JSON.parse(readFileSync(path.join(dir, "mcp.json"), "utf8")).mcpServers;
    const codexBundle = JSON.parse(readFileSync(path.join(dir, "codex-secrets.json"), "utf8"));
    return [mcp.gateway.env.CG_GATEWAY_CAPABILITY, codexBundle.gatewayCapability].map((cap) => verifyGatewayCapability(cap, { secret: SECRET }).claims.jti);
  };
  const [claudeFirst, codexFirst] = await prepare();
  // A `claude` the developer already started holds an open relay connection on its grant.
  const runningClaude = retainRemoteMcps(claudeFirst);
  const [claudeSecond, codexSecond] = await prepare();
  assert.notEqual(claudeFirst, claudeSecond);
  assert.ok(hasRemoteMcps(claudeFirst), "a running claude keeps the relays it started with");
  assert.ok(!hasRemoteMcps(codexFirst), "an unused previous grant is released at the refresh, not left for 12 hours");
  assert.ok(hasRemoteMcps(claudeSecond) && hasRemoteMcps(codexSecond), "the current preparation's grants are live");
  runningClaude();
  assert.ok(!hasRemoteMcps(claudeFirst), "and it goes once that process hangs up");

  // The developer's last session ends: every grant it minted goes, even one a process still holds.
  const stillRunning = retainRemoteMcps(claudeSecond);
  await session.releaseSshSession({ target: t, entry: sessionEntry, user, cliBin: "podman", lastForUser: true, lastInChannel: false, log: { log() {} } }, { runCommand: async () => {} });
  assert.ok(!hasRemoteMcps(claudeSecond) && !hasRemoteMcps(codexSecond));
  stillRunning();
});

// ── Container-secrets P3: a session on placeholders ────────────────────────────────────────────
// Where the egress proxy is the container's network, a developer's session holds what a turn's
// process holds — placeholders for every ruled secret, the relay placeholder as Claude's login —
// and the proxy/CA environment leads the env file. Nothing under the developer's dir, the editor
// token file or the login written into the container may carry a REAL protected value.
const { upsertChannelEntry, patchChannelMeta, defaultChannelMeta, getChannelMeta, setUser } = await import("../src/config/store.js");
const { patchChannelEnv } = await import("../src/config/channel-env.js");
const { patchOrgEnv, patchUserEnv } = await import("../src/config/scoped-env.js");
const grants = await import("../src/gateway/egress/grants.js");
const liveness = await import("../src/gateway/egress/liveness.js");
const { corePlaceholder } = await import("../src/gateway/egress/placeholders.js");
const { installVscodeClaudeRelay } = await import("../src/runtimes/container/vscode.js");
const { SESSION_GIT_SSH_COMMAND } = await import("../src/gateway/ssh-access.js");

const REAL = {
  org: "vercel_org_real_value_ssh_p3_0001",
  channel: "ghp_channel_real_value_ssh_p3_0001",
  raw: "raw-unruled-real-value-ssh-p3-0001",
  personal: "personal-real-value-ssh-p3-0001",
};
const EGRESS_PLAN = { mode: "proxy", active: true, network: "none", rawNetwork: false, socketDir: "/gw/eg/abc", caBundle: "/gw/run/egress-ca.pem", caSpki: "c3BraQ==" };

async function egressChannel(channelId) {
  const created = await upsertChannelEntry(channelId, { name: channelId, type: "channel", isDM: false, platform: "slack" });
  await patchChannelMeta(created.slug, (existing) => {
    let env = existing?.env || {};
    env = patchChannelEnv(env, { set: { name: "GITHUB_TOKEN", value: REAL.channel } });
    env = patchChannelEnv(env, { set: { name: "RAW_THING", value: REAL.raw } });
    return { ...(existing || defaultChannelMeta({ channelId, name: channelId, type: "channel", isDM: false })), env };
  });
  return { entry: { slug: created.slug, channelId }, meta: await getChannelMeta(created.slug) };
}
function egressTarget(slug, channelId, { strict = false } = {}) {
  const base = target(slug);
  return { ...base, meta: { channelId }, settings: { ...(base.settings || {}), egressMode: "proxy", egressSecretsStrict: strict }, container: { name: `cg-${slug}`, egress: { ...EGRESS_PLAN } } };
}
function egressDeps() {
  const { execs, deps } = fakes();
  const { resolveEnv: _fake, ...rest } = deps;
  return {
    execs,
    deps: { ...rest, installRelay: (t, cli, options) => installVscodeClaudeRelay(t, cli, { ...options, resolveToken: async () => relay }) },
  };
}
function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}
const sourceEnv = (file, script) => execFileSync("sh", ["-c", `. '${file}'; ${script}`], { encoding: "utf8", env: { PATH: process.env.PATH, ALL_PROXY: "socks5://leak:1", HTTPS_PROXY: "http://host-proxy:8080" } });

test("under the egress proxy the session holds placeholders, the proxy env, and the relay placeholder as its login — no real value anywhere", async () => {
  patchOrgEnv({ set: { name: "VERCEL_TOKEN", value: REAL.org } });
  await setUser(user.id, { name: "Dev", approved: true });
  await patchUserEnv(user.id, { set: { name: "DEV_API_KEY", value: REAL.personal, hosts: ["api.dev.example"] } });
  const { entry: e, meta } = await egressChannel("C_SSH_EGRESS");
  const t = egressTarget("ssh-egress", e.channelId);
  const { execs, deps } = egressDeps();
  const result = await session.prepareSshSession({ target: t, entry: e, meta, user, cliBin: "podman", log: { warn() {} } }, deps);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.secrets, [
    { name: "DEV_API_KEY", scope: "personal", protected: true },
    { name: "GITHUB_TOKEN", scope: "channel", protected: true },
    { name: "RAW_THING", scope: "channel", protected: false },
    { name: "VERCEL_TOKEN", scope: "organization", protected: true },
  ]);
  assert.deepEqual(result.egress, { active: true, unprotected: ["RAW_THING"], withheld: [], personalPaused: false });

  const dir = session.sshUserDir(t, user.id);
  const envFile = path.join(dir, "env");
  // The env file: proxy block first, then the secrets — placeholders for every ruled name.
  const body = readFileSync(envFile, "utf8");
  const exports = body.split("\n").filter((line) => line.startsWith("export ")).map((line) => line.slice(7, line.indexOf("=")));
  assert.ok(exports.indexOf("HTTPS_PROXY") < exports.indexOf("GITHUB_TOKEN") && exports.indexOf("GIT_SSH_COMMAND") < exports.indexOf("CG_SESSION_ENV"), "the proxy block leads the file");
  const keys = { gh: "GITHUB_TOKEN", v: "VERCEL_TOKEN", p: "DEV_API_KEY", raw: "RAW_THING", https: "HTTPS_PROXY", http: "http_proxy", all: "ALL_PROXY", ca: "NODE_EXTRA_CA_CERTS", git: "GIT_SSH_COMMAND", chromium: "AGENT_BROWSER_ARGS", eg: "CG_EGRESS" };
  const printed = sourceEnv(envFile, Object.values(keys).map((name) => `printf '%s\\n' "\${${name}:-}"`).join("; ")).split("\n");
  const values = Object.fromEntries(Object.keys(keys).map((key, i) => [key, printed[i]]));
  assert.match(values.gh, /^cgph_c[a-z2-7]{32}$/);
  assert.match(values.v, /^cgph_o[a-z2-7]{32}$/);
  assert.match(values.p, /^cgph_p[a-z2-7]{32}$/);
  assert.equal(grants.lookupGrant(values.p).ownerId, user.id, "the personal placeholder is THIS developer's, bound to this channel");
  assert.equal(grants.lookupGrant(values.p).channelId, e.channelId);
  assert.equal(values.raw, REAL.raw, "an unruled name stays raw — flagged, exactly as in a turn");
  assert.equal(values.https, "http://127.0.0.1:3128", "sourcing the file re-asserts the proxy over whatever the shell had");
  assert.equal(values.http, "http://127.0.0.1:3128");
  assert.equal(values.all, "", "ALL_PROXY is unset");
  assert.equal(values.ca, "/run/channelgate/egress-ca.pem");
  assert.equal(values.git, SESSION_GIT_SSH_COMMAND);
  assert.equal(values.git, "ssh -o ProxyCommand='/opt/channelgate/bin/cg-egress-connect %h %p'");
  assert.equal(values.chromium, "--proxy-server=http://127.0.0.1:3128 --ignore-certificate-errors-spki-list=c3BraQ==");
  assert.equal(values.eg, "proxy");

  // The login: the access-only file holds the relay PLACEHOLDER and the real login's plan facts.
  const creds = execs.find((x) => x.args.includes("sh") && String(x.args.at(-1)).includes(".credentials.json"));
  const written = JSON.parse(creds.input).claudeAiOauth;
  assert.match(written.accessToken, /^sk-ant-oat01-cgph_r[a-z2-7]{32}$/);
  assert.equal(grants.lookupGrant(corePlaceholder(written.accessToken)).scope, "relay");
  assert.deepEqual({ expiresAt: written.expiresAt, scopes: written.scopes, subscriptionType: written.subscriptionType, rateLimitTier: written.rateLimitTier },
    { expiresAt: relay.expiresAt, scopes: relay.scopes, subscriptionType: relay.subscriptionType, rateLimitTier: relay.rateLimitTier }, "plan facts are not secrets");
  // The editor token file (read through the artifact mount by the wrapper's non-SSH branch): the same placeholder.
  const editorToken = path.join(t.artifactDir, "vscode", "claude-token");
  assert.equal(readFileSync(editorToken, "utf8"), written.accessToken);
  // The wrapper was rendered from that file, and the onboarding seed ran.
  assert.ok(execs.some((x) => String(x.input).includes("exec /usr/local/bin/claude")));

  // THE requirement: no REAL protected value in any file under the developer's dir, the editor
  // token, or the login written into the container (Codex bundle and args included).
  const everything = [...filesUnder(dir), editorToken].map((file) => ({ file, text: readFileSync(file, "utf8") }));
  everything.push({ file: "<credentials.json input>", text: creds.input });
  assert.ok(everything.some((f) => f.file.endsWith("codex-secrets.json")) && everything.some((f) => f.file.endsWith("mcp.json")));
  for (const { file, text } of everything) {
    for (const real of [REAL.org, REAL.channel, REAL.personal, relay.token]) assert.ok(!text.includes(real), `${file} carries a real value`);
    if (!file.endsWith("/env")) assert.ok(!text.includes(REAL.raw), `${file}: the unprotected raw value lives only in the env file`);
  }
  // The note: the proxy, the CA, placeholders, the personal pause rule, outbound SSH — names only.
  const note = readFileSync(path.join(dir, "session.md"), "utf8");
  for (const phrase of ["egress proxy", "/run/channelgate/egress-ca.pem", "PLACEHOLDERS", "`printenv` shows nothing worth copying", "another-person-ssh-session", "/opt/channelgate/bin/cg-egress-connect %h %p", "cannot add an SSH key", '["RAW_THING"]']) {
    assert.ok(note.includes(phrase), `the session note names: ${phrase}`);
  }
  for (const secret of [...Object.values(REAL), values.gh, values.p, values.v]) assert.ok(!note.includes(secret), "no value and no placeholder in the note");

  // Release: the developer's files, then with the channel's last session the editor token too.
  await session.releaseSshSession({ target: t, entry: e, user, cliBin: "podman", lastForUser: true, lastInChannel: false, log: { log() {} } }, { runCommand: async () => {} });
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(editorToken), true);
  await session.releaseSshSession({ target: t, entry: e, user, cliBin: "podman", lastForUser: true, lastInChannel: true, log: { log() {} } }, { runCommand: async () => {} });
  assert.equal(existsSync(editorToken), false, "release removes everything the session put on the host side");
});

test("strict egress: the unruled secret is withheld, and then NOTHING real is anywhere in the session", async () => {
  const { entry: e, meta } = await egressChannel("C_SSH_EGRESS_STRICT");
  const t = egressTarget("ssh-egress-strict", e.channelId, { strict: true });
  const { execs, deps } = egressDeps();
  const result = await session.prepareSshSession({ target: t, entry: e, meta, user, cliBin: "podman", log: { warn() {} } }, deps);
  assert.deepEqual(result.egress.withheld, ["RAW_THING"]);
  assert.ok(!result.secrets.some((s) => s.name === "RAW_THING"));
  assert.ok(result.secrets.every((s) => s.protected), "every injected name is protected");
  const { realValues } = await grants.resolveEgressRunEnv({ meta, channelId: e.channelId, authorId: user.id, target: t });
  assert.ok(realValues.includes(REAL.raw) && realValues.includes(REAL.channel));
  const texts = [...filesUnder(session.sshUserDir(t, user.id)), path.join(t.artifactDir, "vscode", "claude-token")].map((file) => [file, readFileSync(file, "utf8")]);
  texts.push(["<credentials.json input>", execs.find((x) => String(x.args.at(-1)).includes(".credentials.json")).input]);
  for (const [file, text] of texts) for (const real of [...realValues, relay.token]) assert.ok(!text.includes(real), `${file} carries a real value`);
  assert.match(readFileSync(path.join(session.sshUserDir(t, user.id), "session.md"), "utf8"), /Withheld by the gateway's strict egress setting[^\n]*\["RAW_THING"\]/);
});

test("with another developer attached, this developer's personal placeholders are paused — the session says so", async () => {
  const { entry: e, meta } = await egressChannel("C_SSH_EGRESS_PAUSE");
  const t = egressTarget("ssh-egress-pause", e.channelId);
  liveness.__setSshSessionSource(() => [{ channelId: e.channelId, userId: "U_SOMEONE_ELSE", slug: e.slug }]);
  try {
    const { deps } = egressDeps();
    const result = await session.prepareSshSession({ target: t, entry: e, meta, user, cliBin: "podman", log: { warn() {} } }, deps);
    assert.equal(result.egress.personalPaused, true);
    assert.ok(result.secrets.some((s) => s.name === "DEV_API_KEY" && s.protected), "still injected — the proxy, not the file, enforces the pause");
    assert.match(readFileSync(path.join(session.sshUserDir(t, user.id), "session.md"), "utf8"), /personal secrets are PAUSED/);
    // Only the developer's OWN session in the channel: not paused.
    liveness.__setSshSessionSource(() => [{ channelId: e.channelId, userId: user.id, slug: e.slug }]);
    const own = await session.prepareSshSession({ target: t, entry: e, meta, user, cliBin: "podman", log: { warn() {} } }, egressDeps().deps);
    assert.equal(own.egress.personalPaused, false);
  } finally {
    liveness.__setSshSessionSource(null);
  }
});

test("Codex over SSH behind the egress proxy: the relayed access-only login is placed first, and a failure to place it is reported, never fatal to the session", async () => {
  const t = target("ssh-codex-relay");
  t.container.credentialMode = { claude: "relay", codex: "relay" };
  const placed = [];
  const { deps } = fakes();
  const ok = await session.prepareSshSession({ target: t, entry: { slug: "ssh-codex-relay", channelId: "C_CXR" }, meta: {}, user, cliBin: "podman", log: { warn() {} } },
    { ...deps, installCodexLogin: async (tgt) => { placed.push(tgt.container.name); return null; } });
  assert.deepEqual(placed, [t.container.name], "the relay login is written into this channel's container");
  assert.equal(ok.codex.ready, true, ok.codex.reason);

  const refused = await session.prepareSshSession({ target: t, entry: { slug: "ssh-codex-relay", channelId: "C_CXR" }, meta: {}, user, cliBin: "podman", log: { warn() {} } },
    { ...deps, installCodexLogin: async () => "the gateway has no Codex sign-in to relay" });
  assert.equal(refused.codex.ready, false);
  assert.match(refused.codex.reason, /Codex sign-in not placed: the gateway has no Codex sign-in to relay/);
  assert.equal(refused.claude.relayed, true, "Claude is unaffected");

  // The shared-file mode (legacy bridge) writes nothing.
  const bridged = target("ssh-codex-bridge");
  bridged.container.credentialMode = { claude: "relay", codex: "shared-file" };
  const none = [];
  await session.prepareSshSession({ target: bridged, entry: { slug: "ssh-codex-bridge", channelId: "C_CXB" }, meta: {}, user, cliBin: "podman", log: { warn() {} } },
    { ...deps, installCodexLogin: async () => { none.push(1); return null; } });
  assert.deepEqual(none, []);
});
