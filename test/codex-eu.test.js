import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { codexEuLoginHome, codexEuCredentialState, makeCodexEuAdapter } = await import("../src/engines/codex-eu.js");
const { codexLoginCandidatesFor } = await import("../src/gateway/channel-codex-auth.js");
const { codexAuthProcessEnv } = await import("../src/gateway/channel-codex-paths.js");
const { buildCodexEnv, buildCodexArgs, installRelayedCodexLogin } = await import("../src/engines/codex.js");
const { settleCredentialModes } = await import("../src/runtimes/container/credentials.js");
const { containerRunEnv } = await import("../src/runtimes/container/exec.js");
const { buildMounts } = await import("../src/runtimes/container/lifecycle.js");
const { requireAdapter, resumeCommandFor } = await import("../src/engines/registry.js");
const grants = await import("../src/gateway/egress/grants.js");
const file = path.join(codexEuLoginHome(), "auth.json");
const jwt = (plan = "enterprise") => `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000) + 864000, "https://api.openai.com/auth": { chatgpt_plan_type: plan, chatgpt_account_id: "eu-test" } })).toString("base64url")}.fixture`;
const auth = (plan) => JSON.stringify({ tokens: { access_token: jwt(plan), refresh_token: "fixture-refresh", account_id: "eu-test" } });
const write = (body) => { mkdirSync(codexEuLoginHome(), { recursive: true, mode: 0o700 }); writeFileSync(file, body, { mode: 0o600 }); };
function target() { return { backend: "container", meta: { channelId: "C_EU", engine: "codex-eu", codexAuthSource: "channel" }, runtime: { spawn() {}, capabilities: { isolated: true }, helperCommand: () => ({ command: "node", args: ["/helper.js"] }) }, container: { home: "/home/agent", codexHome: "/home/agent/.codex-eu", codexEuHome: "/home/agent/.codex-eu", credentialMode: { codex: "missing" }, egress: { active: true, mode: "proxy", network: "none" } } }; }

test("Codex EU checks only its dedicated Enterprise file and never substitutes an API key or default login", async () => {
  const seen = [];
  const absent = await codexEuCredentialState({ readFileImpl: async (name) => { seen.push(name); throw Object.assign(new Error("missing"), { code: "ENOENT" }); } });
  assert.equal(absent.authenticated, false);
  assert.deepEqual(seen, [file]);
  assert.match(absent.detail, /--device-auth/);
  for (const body of [JSON.stringify({ OPENAI_API_KEY: "fixture-api" }), auth("plus"), auth("business"), "malformed"]) {
    assert.equal((await codexEuCredentialState({ readFileImpl: async () => body })).authenticated, false);
  }
  assert.equal((await codexEuCredentialState({ readFileImpl: async () => auth("enterprise") })).authenticated, true);
  assert.deepEqual(codexLoginCandidatesFor({ engine: "codex-eu", codexAuthSource: "channel" }), [file]);
});

test("EU runner environments isolate host and container login and strip inherited OpenAI API credentials", () => {
  const source = { OPENAI_API_KEY: "fixture-api", CODEX_API_KEY: "fixture-code", OPENAI_BASE_URL: "https://other.invalid", CODEX_HOME: "/default" };
  const container = buildCodexEnv({ target: target() }, source);
  assert.equal(container.CODEX_HOME, "/home/agent/.codex-eu");
  assert.equal(containerRunEnv(target(), container).CODEX_HOME, "/home/agent/.codex-eu", "actual container spawn must preserve the reviewed EU target home");
  assert.equal(containerRunEnv(target(), { CODEX_HOME: "/untrusted" }).CODEX_HOME, "/home/agent/.codex-eu", "caller environment cannot override the selected target home");
  assert.equal(container.OPENAI_API_KEY, undefined);
  assert.equal(container.CODEX_API_KEY, undefined);
  assert.equal(container.OPENAI_BASE_URL, undefined);
  const host = buildCodexEnv({ target: { backend: "host", meta: { engine: "codex-eu" } } }, source);
  assert.equal(host.CODEX_HOME, codexEuLoginHome());
  assert.equal(host.OPENAI_API_KEY, undefined);
  assert.equal(host.CODEX_API_KEY, undefined);
  assert.equal(codexAuthProcessEnv(codexEuLoginHome()).CODEX_HOME, codexEuLoginHome());
  const args = buildCodexArgs({ prompt: "hello", cwd: "/work", isNewSession: true, networkMode: "off", target: target(), outFile: "/out" });
  assert.ok(args.includes('cli_auth_credentials_store="file"'));
});

test("EU adapter is a separate optional harness and cannot fail over or share physical state", async () => {
  const base = requireAdapter("codex");
  const eu = makeCodexEuAdapter(base);
  assert.equal(eu.id, "codex-eu");
  assert.equal(eu.modelFamily, "codex");
  assert.equal(eu.supports.usageLimitFallback, false);
  assert.equal(eu.sessionState.hostDir(), codexEuLoginHome());
  assert.equal(eu.sessionState.containerDirKey, "codexEuHome");
  assert.deepEqual(await eu.discoverMcps(), []);
  rmSync(file, { force: true });
  assert.equal((await eu.selectionReadiness()).ready, false);
  write(auth("enterprise"));
  assert.equal((await eu.selectionReadiness()).ready, true);
  write(auth("plus"));
  assert.equal((await eu.selectionReadiness()).ready, false, "readiness must reflect rotation without TTL");
});

test("EU never mounts its full login in any container, including selected legacy bridge channels", () => {
  write(auth("enterprise"));
  const common = { CODEX_HOME: "/missing-normal" };
  const normal = settleCredentialModes({}, common, { meta: { engine: "codex" }, egressActive: true });
  const eu = settleCredentialModes({}, common, { meta: { engine: "codex-eu" }, egressActive: true });
  assert.deepEqual(normal, eu);
  rmSync(file);
  assert.deepEqual(settleCredentialModes({}, common, { meta: { engine: "codex-eu" }, egressActive: true }), eu, "signing in or out of EU never changes create-time container facts");
  write(auth("enterprise"));
  assert.equal(eu.modes.codexEu, undefined, "EU credentials must never affect a container create-time fingerprint");
  assert.equal(eu.codexEuAuthFile, undefined);
  const bridge = settleCredentialModes({}, common, { meta: { engine: "codex-eu" }, egressActive: false });
  assert.equal(bridge.modes.codexEu, undefined);
  assert.equal(bridge.codexEuAuthFile, undefined);
  const mounts = buildMounts({ codexEuAuthFile: file });
  assert.ok(!mounts.some(m => m.kind === "codex-eu-auth" || m.source === file));
});

test("EU proxy grants keep their login identity while the live channel selects ordinary or channel Codex", async () => {
  write(auth("enterprise"));
  let candidates;
  const credential = await grants.containerCodexCredential({ target: target(), resolveRelay: async (opts) => { candidates = opts.candidates; return { token: jwt(), source: "chatgpt", accountId: "eu-test" }; } });
  assert.deepEqual(candidates, [file]);
  const parsed = JSON.parse(credential.authJson);
  assert.equal(parsed.tokens.refresh_token, "");
  assert.notEqual(parsed.tokens.access_token, jwt());
  const euPlaceholder = grants.codexRelayPlaceholderFor({ channelId: "C_EU", eu: true });
  const normalPlaceholder = grants.codexRelayPlaceholderFor({ channelId: "C_EU" });
  assert.notEqual(euPlaceholder, normalPlaceholder);
  const row = grants.lookupGrant(euPlaceholder);
  assert.equal(row.secretName, "CODEX_EU_ACCESS_TOKEN");
  const value = await grants.resolveGrantValue(row, { metaFor: async () => ({ codexAuthSource: "channel" }), codexRelayToken: async (opts) => { assert.deepEqual(opts.candidates, [file]); return { token: "fixture-eu-live", source: "chatgpt" }; } });
  assert.equal(value, "fixture-eu-live");
  write(auth("plus"));
  assert.equal(await grants.resolveGrantValue(row), "", "a cached Enterprise grant pauses immediately after wrong-account rotation");
});

test("relay writer installs only EU state without replacing the ordinary Codex login", async () => {
  const writes = [];
  const selected = target();
  selected.runtime.writeHomeFile = async (_, spec) => writes.push(spec);
  const error = await installRelayedCodexLogin(selected, { credential: async () => ({ authJson: '{"fixture":"eu"}' }) });
  assert.equal(error, null);
  assert.deepEqual(writes.map(w => w.file), ["/home/agent/.codex-eu/auth.json"]);
});


test("the EU adapter routes a real run through the dedicated state while retaining managed MCP payloads", async () => {
  write(auth("enterprise"));
  let actual;
  const eu = makeCodexEuAdapter({ ...requireAdapter("codex"), run: async (ctx) => { actual = ctx; return { text: "done" }; } });
  const sharedTarget = target();
  sharedTarget.container.codexHome = "/home/agent/.codex";
  const managed = [{ name: "managed", definition: {} }];
  const result = await eu.run({ target: sharedTarget, runtime: { allowedMcps: ["operator-private"], managedMcpServers: managed } });
  assert.equal(result.text, "done");
  assert.equal(actual.target.container.codexHome, "/home/agent/.codex-eu");
  assert.equal(sharedTarget.container.codexHome, "/home/agent/.codex", "the simultaneous normal Codex target is unchanged");
  assert.deepEqual(actual.runtime.allowedMcps, []);
  assert.equal(actual.runtime.managedMcpServers, managed);
  assert.equal(actual.runtime.codexStateDir, "");
  await eu.run({ target: { backend: "host", meta: {} }, runtime: {} });
  assert.equal(actual.runtime.codexStateDir, codexEuLoginHome());
});


test("generated resume commands use the selected runtime's EU home with an executable env prefix", () => {
  const host = resumeCommandFor("codex-eu", "eu-session", { target: { backend: "host" } });
  assert.equal(host, `env CODEX_HOME='${codexEuLoginHome()}' codex exec resume 'eu-session'`);
  const container = resumeCommandFor("codex-eu", "eu-session", { target: { backend: "container", container: { codexEuHome: "/home/agent/.codex-eu-test" }, runtime: {
    capabilities: { isolated: true }, resumeCommand: (_, { baseCommand }) => `podman exec -it example ${baseCommand}`,
  } } });
  assert.equal(container, "podman exec -it example env CODEX_HOME='/home/agent/.codex-eu-test' codex exec resume 'eu-session'");
  assert.ok(!container.includes(codexEuLoginHome()));
});

test("selecting EU without active proxy egress refuses before any authentication file can be mounted", async () => {
  const { credentialError } = await import("../src/runtimes/container/credentials.js");
  write(auth("enterprise"));
  const selected = target();
  selected.container.egress = { mode: "bridge", active: false, network: "bridge" };
  assert.match(credentialError(selected, "codex-eu").message, /requires the container egress proxy/);
  assert.equal(credentialError(target(), "codex-eu"), null);
});
