// An interactive SSH session gets what a chat turn gets (gateway/ssh-session.js): the channel
// lockdown, the per-session MCP payload with a signed capability for THIS developer and the "ssh"
// toolset, the run environment, and an account-shaped Claude login without a refresh token.
// Live finding (0.5.3): over SSH, `claude` had no MCP servers, no secrets and looked signed out
// ("Claude API") while a Slack turn in the same channel had all of it.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  const runCommand = async (bin, args, options = {}) => {
    execs.push({ bin, args, input: options.input || "" });
    if (!relayOk && args.includes("sh") && String(args.at(-1)).includes(".credentials.json")) throw new Error("exec failed");
  };
  return {
    execs,
    deps: {
      runCommand,
      installRelay: async (_target, _cli, opts) => { execs.push({ bin: "relay", args: [opts.usersDir], input: "" }); return { source: "operator", expiresAt: relay.expiresAt, relay }; },
      resolveIntegrations: async ({ authorId, threadKey, clean }) => ({
        composioUserToken: clean ? "" : `cu-${authorId}`, composioToken: clean ? "" : "ca-channel", composioUserEndpoint: null, composioEndpoint: null,
        toolboxToken: "", makeToolboxUrl: "", makeToolboxKey: "", threadKey,
      }),
      resolveEnv: async ({ authorId, clean }) => ({ env: clean ? {} : { GITHUB_PAT: "it's a 'quoted'\nvalue", MAKE_API: `m-${authorId}`, LD_PRELOAD: "/evil.so" }, scopes: {} }),
      buildLockdown: async (meta) => { if (lockdownFails) throw new Error("no lockdown"); return { permissions: { allow: ["Read"], deny: [] }, allowedMcpServers: [{ serverName: "gateway" }], slug: meta._slug }; },
      readAccount: () => account,
      now: () => 1_700_000_000_000,
    },
  };
}

test("the session is prepared like a turn: lockdown, MCP payload signed for THIS developer on the ssh toolset, sourced secrets, account login without a refresh token", async () => {
  const t = target();
  const { execs, deps } = fakes();
  const result = await session.prepareSshSession({ target: t, entry, meta: { allowedMcps: [] }, user, cliBin: "podman", log: { warn() {} } }, deps);
  assert.deepEqual(result.claude, { relayed: true, source: "operator", reason: "", account: true });
  assert.equal(result.toolset, SSH_TOOLSET);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.mcpServers.sort(), ["composio-agent", "composio-user", "gateway"]);
  assert.deepEqual(result.secrets, ["GITHUB_PAT", "MAKE_API"], "reserved names are filtered like a turn's (safeSpawnEnv)");
  const dir = session.sshUserDir(t, user.id);
  assert.equal(dir, path.join(containerSshDir(t), "users", user.id), "beside the channel's sshd files, per developer");
  for (const name of ["mcp.json", "settings.json", "env"]) assert.equal(statSync(path.join(dir, name)).mode & 0o777, 0o600, name);
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
  assert.ok(JSON.stringify(mcp["composio-user"]).includes(`cu-${user.id}`), "the developer's OWN Composio identity");
  assert.ok(JSON.stringify(mcp["composio-agent"]).includes("ca-channel"), "and the channel's");
  // The env file: every value single-quoted so a POSIX shell reproduces it exactly; no token in it
  // when the account login was written (the file login is what Claude shows as the account).
  const envFile = readFileSync(path.join(dir, "env"), "utf8");
  assert.ok(!envFile.includes("CLAUDE_CODE_OAUTH_TOKEN"), "no token rides the environment when the login file exists");
  assert.ok(!envFile.includes("LD_PRELOAD"));
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
  execs.length = 0;
  await session.releaseSshSession({ target: t, user, cliBin: "podman", lastForUser: false, lastInChannel: false, log: { log() {} } }, { runCommand: deps.runCommand });
  assert.equal(existsSync(dir), true, "another session of this developer still uses them");
  assert.deepEqual(execs, []);
  await session.releaseSshSession({ target: t, user, cliBin: "podman", lastForUser: true, lastInChannel: false, log: { log() {} } }, { runCommand: deps.runCommand });
  assert.equal(existsSync(dir), false);
  assert.deepEqual(execs, [], "the login stays while other developers are in the channel");
  await session.releaseSshSession({ target: t, user, cliBin: "podman", lastForUser: true, lastInChannel: true, log: { log() {} } }, { runCommand: deps.runCommand });
  assert.equal(execs.length, 2);
  assert.match(execs[0].args.at(-1), /^rm -f \/home\/agent\/\.claude\/\.credentials\.json /);
  assert.deepEqual(execs[1].args.slice(-2), ["/home/agent/.claude/.claude.json", "-"], "the account record is removed, merge-only");
  // A container that is already gone is not an error.
  await session.releaseSshSession({ target: t, user, cliBin: "podman", lastForUser: true, lastInChannel: true, log: { log() {} } }, { runCommand: async () => { throw new Error("no such container"); } });
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
  for (const name of ["update_channel_memory", "search_channel_memory", "list_schedules", "workspace_read", "list_skills", "show_channel_ssh", "list_my_secrets"]) {
    assert.ok(ssh.includes(name), `${name} is available over SSH`);
  }
  assert.deepEqual(full.filter((n) => !ssh.includes(n)).sort(), threadBound.filter((n) => full.includes(n)).sort(), "nothing else differs");
  assert.ok(review.length < ssh.length && review.includes("update_channel_memory"), "the reviewer's surface stays the smallest");
  assert.ok(RUN_ORIGINS.includes(session.SSH_SESSION_ORIGIN));
  assert.equal(PRINCIPAL_KIND_BY_ORIGIN[session.SSH_SESSION_ORIGIN], "user");
});
