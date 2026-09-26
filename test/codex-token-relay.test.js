// The Codex login relay (container-secrets P4): src/gateway/codex-token-relay.js, the JWT-shaped
// placeholder (placeholders.js), the `jwt` swap format (rules.js), the Codex relay grant
// (grants.js containerCodexCredential) and the runner step that places the access-only file.
//
// What must hold: the container's auth.json never carries the real access token, the real
// signature of either JWT or ANY refresh token; the placeholder is stable per channel and swapped
// WHOLE only on the Codex hosts in the Authorization header; the daemon refreshes a nearly-expired
// login with one cheap ephemeral turn in the login's own CODEX_HOME, serialized, and backs off when
// the CLI declines to renew a still-valid token.
//
// Every token here is built at runtime (the secret scan reads this file too).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();

const relay = await import("../src/gateway/codex-token-relay.js");
const { wrapPlaceholder, corePlaceholder, findPlaceholders, jwtClaimSegments, mintPlaceholder, shapePlaceholder, JWT_PLACEHOLDER_RE } = await import("../src/gateway/egress/placeholders.js");
const { swapHeaders, placeholdersInRequest } = await import("../src/gateway/egress/rules.js");
const { CODEX_RELAY_RULE, CODEX_RELAY_SECRET_NAME, relayRuleFor, RELAY_RULE } = await import("../src/gateway/egress/catalog-rules.js");
const { ENGINE_HOSTS } = await import("../src/gateway/egress/engine-hosts.js");
const grants = await import("../src/gateway/egress/grants.js");
const { installRelayedCodexLogin } = await import("../src/engines/codex.js");

const seg = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const SIGNATURE = Buffer.from(`real-signature-${Date.now()}`).toString("base64url");
function jwt(payload, signature = SIGNATURE) {
  return `${seg({ alg: "RS256", kid: "k1", typ: "JWT" })}.${seg(payload)}.${signature}`;
}
const REFRESH = `rt-real-refresh-${Date.now()}`;
function authFile(dir, { expSeconds = Math.floor(Date.now() / 1000) + 9 * 86400, apiKey = false } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "auth.json");
  const body = apiKey
    ? { OPENAI_API_KEY: "sk-test-not-a-real-key" }
    : {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: jwt({ email: "op@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } }),
        access_token: jwt({ exp: expSeconds, "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: "acct-1" } }),
        refresh_token: REFRESH,
        account_id: "acct-1",
      },
      last_refresh: "2026-09-25T04:03:42.731Z",
    };
  writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
  return file;
}

function activeTarget(channelId) {
  return {
    backend: "container",
    runtime: { capabilities: { isolated: true } },
    slug: channelId.toLowerCase(),
    meta: { channelId },
    settings: { egressMode: "proxy" },
    container: { egress: { mode: "proxy", active: true, network: "none", rawNetwork: false, socketDir: "/x", caBundle: "/y", caSpki: "z" } },
  };
}

// ── The JWT-shaped placeholder ────────────────────────────────────────────────────────────────

test("a JWT-shaped placeholder keeps the real header and claims, puts the core in the signature, and is detected as one token", () => {
  const real = jwt({ exp: 1, sub: "user-1" });
  const core = mintPlaceholder({ scope: "relay" });
  const shaped = wrapPlaceholder(core, { shape: "jwt", claimsFrom: real });
  const [header, payload, signature] = shaped.split(".");
  assert.equal(`${header}.${payload}`, real.split(".").slice(0, 2).join("."), "the CLI still reads the real claims");
  assert.equal(signature, core, "the placeholder IS the signature");
  assert.ok(!shaped.includes(SIGNATURE), "the real signature is gone");
  assert.equal(corePlaceholder(shaped), core);
  assert.deepEqual(findPlaceholders(`Bearer ${shaped}`), [core]);
  assert.ok(JWT_PLACEHOLDER_RE.test(shaped));
  assert.match(shapePlaceholder({ scope: "relay", shape: "jwt", claims: real }), JWT_PLACEHOLDER_RE);
  assert.throws(() => wrapPlaceholder(core, { shape: "jwt", claimsFrom: "not-a-jwt" }), /needs the real token's claims/);
  assert.throws(() => wrapPlaceholder("cgph_nope", { shape: "jwt", claimsFrom: real }), /core placeholder/);
  assert.equal(jwtClaimSegments("a.b"), null);
  assert.equal(jwtClaimSegments(`${seg([1])}.${seg({})}.x`), null, "a header that is not a JSON object is not a JWT");
});

// ── The `jwt` swap format ─────────────────────────────────────────────────────────────────────

function codexGrant(value) {
  const core = mintPlaceholder({ scope: "relay" });
  return { placeholder: core, value, secretName: CODEX_RELAY_SECRET_NAME, scope: "relay", owner: null, hosts: [...CODEX_RELAY_RULE.hosts], headers: [...CODEX_RELAY_RULE.headers], format: [...CODEX_RELAY_RULE.format] };
}
const resolverFor = (grant) => (core) => (core === grant.placeholder ? grant : null);

test("jwt format: the WHOLE token is replaced on the Codex hosts, and only there", () => {
  const liveToken = jwt({ exp: 2 }, "live-signature");
  const grant = codexGrant(liveToken);
  const shaped = wrapPlaceholder(grant.placeholder, { shape: "jwt", claimsFrom: jwt({ exp: 1 }) });
  for (const host of ["chatgpt.com", "api.openai.com", "auth.openai.com"]) {
    const out = swapHeaders({ headers: { host, authorization: `Bearer ${shaped}` }, hostname: host, resolveGrant: resolverFor(grant) });
    assert.equal(out.headers.authorization, `Bearer ${liveToken}`, host);
    assert.deepEqual(out.swapped.map((s) => s.secretName), [CODEX_RELAY_SECRET_NAME]);
    assert.equal(out.scrub.get(liveToken), shaped, "a response echoing the live token is scrubbed back to the WHOLE placeholder");
  }
  const elsewhere = swapHeaders({ headers: { host: "example.com", authorization: `Bearer ${shaped}` }, hostname: "example.com", resolveGrant: resolverFor(grant) });
  assert.equal(elsewhere.headers.authorization, `Bearer ${shaped}`, "another host gets the placeholder unchanged");
  assert.equal(elsewhere.refused[0].reason, "host");
  const otherHeader = swapHeaders({ headers: { host: "chatgpt.com", "x-api-key": shaped }, hostname: "chatgpt.com", resolveGrant: resolverFor(grant) });
  assert.equal(otherHeader.headers["x-api-key"], shaped);
  assert.deepEqual(placeholdersInRequest({ headers: { authorization: `Bearer ${shaped}` }, path: "/" }), [grant.placeholder]);
});

test("jwt format: a bare placeholder is refused by a jwt grant, and a JWT-shaped one by a bearer grant", () => {
  const grant = codexGrant(jwt({ exp: 2 }, "live"));
  const bare = swapHeaders({ headers: { host: "chatgpt.com", authorization: `Bearer ${grant.placeholder}` }, hostname: "chatgpt.com", resolveGrant: resolverFor(grant) });
  assert.equal(bare.headers.authorization, `Bearer ${grant.placeholder}`);
  assert.equal(bare.refused[0].reason, "format");

  const bearerGrant = { ...grant, format: ["bearer", "raw"] };
  const shaped = wrapPlaceholder(grant.placeholder, { shape: "jwt", claimsFrom: jwt({ exp: 1 }) });
  const refused = swapHeaders({ headers: { host: "chatgpt.com", authorization: `Bearer ${shaped}` }, hostname: "chatgpt.com", resolveGrant: resolverFor(bearerGrant) });
  assert.equal(refused.headers.authorization, `Bearer ${shaped}`, "never a partial swap of the signature segment");
  assert.equal(refused.refused[0].reason, "format");
});

test("the Codex relay rule: jwt only, Authorization only, the Codex engine hosts", () => {
  assert.deepEqual([...CODEX_RELAY_RULE.format], ["jwt"]);
  assert.deepEqual([...CODEX_RELAY_RULE.headers], ["authorization"]);
  assert.deepEqual([...CODEX_RELAY_RULE.hosts], ["api.openai.com", "chatgpt.com", "auth.openai.com"]);
  for (const host of CODEX_RELAY_RULE.hosts) assert.ok(ENGINE_HOSTS.codex.includes(host), `${host} must stay reachable with the network off`);
  assert.ok(!CODEX_RELAY_RULE.hosts.some((host) => host.startsWith("*")), "the login is never swapped on a wildcard host");
  assert.equal(relayRuleFor(CODEX_RELAY_SECRET_NAME), CODEX_RELAY_RULE);
  assert.equal(relayRuleFor("CLAUDE_CODE_OAUTH_TOKEN"), RELAY_RULE);
  assert.equal(relayRuleFor("toString"), null);
});

// ── The daemon's view of the login ────────────────────────────────────────────────────────────

test("resolveCodexLogin / readDaemonCodexAccessToken: a ChatGPT sign-in, its expiry and account — never the refresh token", () => {
  const dir = tempDir("cg-codex-relay-");
  const file = authFile(dir);
  const login = relay.resolveCodexLogin({ candidates: [path.join(dir, "missing", "auth.json"), file] });
  assert.equal(login.kind, "chatgpt");
  assert.equal(login.file, file);
  assert.equal(login.home, dir);
  const read = relay.readDaemonCodexAccessToken(login);
  assert.ok(read.expiresAt > Date.now());
  assert.equal(read.accountId, "acct-1");
  assert.equal(read.planType, "pro");
  assert.ok(!JSON.stringify(read).includes(REFRESH), "the refresh token is never read out");

  const keyDir = tempDir("cg-codex-relay-key-");
  assert.equal(relay.resolveCodexLogin({ candidates: [authFile(keyDir, { apiKey: true })] }).kind, "api-key");
  assert.equal(relay.resolveCodexLogin({ candidates: [path.join(keyDir, "nope", "auth.json")] }).kind, "none");
  rmSync(dir, { recursive: true, force: true });
  rmSync(keyDir, { recursive: true, force: true });
});

test("resolveContainerCodexToken: fresh → no refresh; nearly expired → ONE refresh turn for concurrent callers; declined → backoff", async () => {
  relay.__resetCodexRelayState();
  const dir = tempDir("cg-codex-relay-stale-");
  const now = Date.now();
  const file = authFile(dir, { expSeconds: Math.floor(now / 1000) + 3600 }); // 1 h left: inside the 48 h window
  let refreshes = 0;
  const refresh = async ({ login }) => {
    refreshes += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (refreshes === 1) authFile(path.dirname(login.file), { expSeconds: Math.floor(now / 1000) + 10 * 86400 });
  };
  const resolveLogin = () => relay.resolveCodexLogin({ candidates: [file] });
  const [a, b] = await Promise.all([
    relay.resolveContainerCodexToken({ refresh, resolveLogin }),
    relay.resolveContainerCodexToken({ refresh, resolveLogin }),
  ]);
  assert.equal(refreshes, 1, "serialized: one refresh for two runs");
  assert.ok(a.expiresAt > now + 9 * 86400_000 && b.expiresAt === a.expiresAt, "both got the renewed token");

  // A fresh token: nothing to do.
  await relay.resolveContainerCodexToken({ refresh, resolveLogin });
  assert.equal(refreshes, 1);

  // The CLI declines to renew a still-valid token: one attempt, then a back-off window.
  relay.__resetCodexRelayState();
  authFile(dir, { expSeconds: Math.floor(now / 1000) + 24 * 3600 }); // a day left: stale, still valid
  let declined = 0;
  const noop = async () => { declined += 1; };
  const first = await relay.resolveContainerCodexToken({ refresh: noop, resolveLogin });
  const second = await relay.resolveContainerCodexToken({ refresh: noop, resolveLogin });
  assert.equal(declined, 1, "no refresh turn on every run while the CLI keeps the token");
  assert.ok(first.token && second.token, "the still-valid token is relayed meanwhile");
  const later = await relay.resolveContainerCodexToken({ refresh: noop, resolveLogin, now: () => Date.now() + relay.CODEX_RELAY_RETRY_MS + 1000 });
  assert.equal(declined, 2, "retried after the back-off");
  assert.ok(later.token);

  // Expired and not renewed → no token, the remedy named.
  relay.__resetCodexRelayState();
  authFile(dir, { expSeconds: Math.floor(now / 1000) - 60 });
  const dead = await relay.resolveContainerCodexToken({ refresh: noop, resolveLogin });
  assert.equal(dead.token, "");
  assert.match(dead.error, /expired.*codex login/);
  rmSync(dir, { recursive: true, force: true });
});

test("the refresh turn: ephemeral, the user config ignored, in the login's own CODEX_HOME, no stdin", async () => {
  const dir = tempDir("cg-codex-relay-spawn-");
  const calls = [];
  const spawnImpl = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => child.emit("close", 0));
    return child;
  };
  await relay.refreshDaemonCodexToken({ login: { kind: "chatgpt", file: path.join(dir, "auth.json"), home: dir }, spawnImpl, log: null });
  assert.equal(calls.length, 1);
  const { cmd, args, options } = calls[0];
  assert.equal(cmd, "codex");
  for (const flag of ["exec", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "-s", "read-only"]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("-m") + 1], relay.CODEX_RELAY_REFRESH_MODEL);
  assert.equal(options.env.CODEX_HOME, dir);
  assert.equal(options.stdio[0], "ignore", "a closed stdin: `codex exec` otherwise waits on it");
  assert.notEqual(options.cwd, dir, "never run in the login's own directory");
  rmSync(dir, { recursive: true, force: true });
});

test("the container auth.json: the placeholder token, the id_token's claims without its signature, an EMPTY refresh token", () => {
  const idToken = jwt({ email: "op@example.com" });
  const body = relay.renderContainerCodexAuth({ accessToken: "hdr.pay.cgph_rabc", idToken, accountId: "acct-1", now: () => Date.parse("2026-09-26T00:00:00Z") });
  const parsed = JSON.parse(body);
  assert.equal(parsed.tokens.refresh_token, "");
  assert.equal(parsed.tokens.access_token, "hdr.pay.cgph_rabc");
  assert.equal(parsed.tokens.id_token.split(".").slice(0, 2).join("."), idToken.split(".").slice(0, 2).join("."));
  assert.equal(parsed.tokens.id_token.split(".")[2], relay.CODEX_ID_TOKEN_SIGNATURE);
  assert.ok(!body.includes(SIGNATURE));
  assert.equal(parsed.last_refresh, "2026-09-26T00:00:00.000Z");
  assert.equal(parsed.auth_mode, "chatgpt");
  assert.equal(parsed.OPENAI_API_KEY, null);
});

// ── The grant and the runner step ─────────────────────────────────────────────────────────────

test("containerCodexCredential: a per-channel JWT placeholder whose grant resolves to the LIVE token on the Codex hosts; nothing without the proxy", async () => {
  grants.__resetGrantCaches();
  const live = jwt({ exp: Math.floor(Date.now() / 1000) + 5 * 86400, "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } }, "live-signature");
  const resolveRelay = async () => ({ token: live, idToken: jwt({ email: "op@example.com" }), accountId: "acct-1", expiresAt: 1, source: "chatgpt" });
  const a = await grants.containerCodexCredential({ target: activeTarget("C_CODEX_RELAY_A"), resolveRelay });
  const parsed = JSON.parse(a.authJson);
  const core = corePlaceholder(parsed.tokens.access_token);
  assert.match(core, /^cgph_r[a-z2-7]{32}$/);
  assert.equal(core, grants.codexRelayPlaceholderFor({ channelId: "C_CODEX_RELAY_A" }), "stable per channel");
  assert.ok(!a.authJson.includes("live-signature") && !a.authJson.includes(SIGNATURE), "no real signature in the container file");
  assert.equal(parsed.tokens.refresh_token, "");
  const b = await grants.containerCodexCredential({ target: activeTarget("C_CODEX_RELAY_B"), resolveRelay });
  assert.notEqual(corePlaceholder(JSON.parse(b.authJson).tokens.access_token), core, "another channel, another placeholder");

  const grant = await grants.resolveEgressGrant(core, { codexRelayToken: resolveRelay });
  assert.equal(grant.value, live);
  assert.deepEqual(grant.format, ["jwt"]);
  assert.deepEqual(grant.hosts, [...CODEX_RELAY_RULE.hosts]);
  assert.equal(grant.secretName, CODEX_RELAY_SECRET_NAME);

  const inactive = { ...activeTarget("C_CODEX_RELAY_A"), container: { egress: { mode: "bridge", active: false } } };
  assert.match((await grants.containerCodexCredential({ target: inactive, resolveRelay })).error, /egress proxy/);
  const nothing = await grants.containerCodexCredential({ target: activeTarget("C_CODEX_RELAY_A"), resolveRelay: async () => ({ token: "", error: "Codex is not signed in on the gateway host" }) });
  assert.equal(nothing.authJson, undefined);
  assert.match(nothing.error, /not signed in/);
});

test("installRelayedCodexLogin writes the file through the backend, refuses a still-mounted shared file, and names a missing login", async () => {
  const writes = [];
  const t = {
    ...activeTarget("C_CODEX_INSTALL"),
    runtime: { capabilities: { isolated: true }, writeHomeFile: async (_t, entry) => { writes.push(entry); } },
  };
  t.container = { ...t.container, home: "/home/agent", codexHome: "/home/agent/.codex", mounts: [] };
  const credential = async () => ({ authJson: '{"tokens":{"refresh_token":""}}' });
  assert.equal(await installRelayedCodexLogin(t, { credential }), null);
  assert.deepEqual(writes, [{ file: "/home/agent/.codex/auth.json", body: '{"tokens":{"refresh_token":""}}' }]);

  const mounted = { ...t, container: { ...t.container, mounts: [{ kind: "codex-auth", source: "/real/auth.json" }] } };
  assert.match(await installRelayedCodexLogin(mounted, { credential }), /still mounts the shared Codex sign-in file/);
  assert.equal(writes.length, 1, "never written while the real file is mounted there");

  assert.match(await installRelayedCodexLogin(t, { credential: async () => ({ error: "the gateway has no Codex sign-in to relay" }) }), /no Codex sign-in to relay.*codex login/);
  assert.match(await installRelayedCodexLogin({ ...t, runtime: { capabilities: { isolated: true } } }, { credential }), /no writeHomeFile/);
});
