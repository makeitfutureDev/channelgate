// The egress proxy's environment inside a channel container (src/runtimes/container/egress-env.js):
// ONE helper decides the proxy + CA variables, and it rides in all three places a container gets an
// environment — the create-time `-e` (what cg-init and anything not exec'd sees), every exec's
// env-file (FORCED, so a daemon HTTPS_PROXY can never route a run around the proxy), and the
// gateway-owned last group of the Claude and Codex env. With the proxy not active nothing changes.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { egressEnv, applyEgressEnv, EGRESS_ENV_NAMES, EGRESS_CA_ENV_NAMES, EGRESS_PROXY_URL } = await import("../src/runtimes/container/egress-env.js");
const { setEgressProvider } = await import("../src/runtimes/container/egress-hook.js");
const { resolveRuntime } = await import("../src/runtimes/resolve.js");
const { buildCreateArgs } = await import("../src/runtimes/container/lifecycle.js");
const { containerRunEnv } = await import("../src/runtimes/container/exec.js");
const { buildClaudeEnv } = await import("../src/engines/claude.js");
const { buildCodexEnv } = await import("../src/engines/codex.js");
const { isReservedEnvName, assertValidEnvName } = await import("../src/config/channel-env.js");
const { browserSpawnEnv, browserEgressArgs, BROWSER_ARGS_ENV } = await import("../src/gateway/browser-env.js");

const SETTINGS = { cli: "auto", image: "channelgate/runtime:latest", pidsLimit: 1024, memory: "", cpus: "", hasClaudeOauthToken: true };
const CA = "/run/channelgate/egress-ca.pem";
const SPKI = "q83vEjRWeJq83vEjRWeJq83vEjRWeJq83vEjRWeJq80=";
// Built at runtime so the source never carries a string shaped like a real Anthropic token.
const RELAY_PLACEHOLDER = `${["sk", "ant", "oat01"].join("-")}-cgph_rabcdefghijklmnopqrstuvwxyz234567`;

const provider = {
  running: () => true,
  socketDirFor: ({ slug }) => `/gw/eg/${slug}`,
  caBundlePath: () => "/gw/run/egress-ca.pem",
  caSpki: () => SPKI,
  ensure: async () => ({}),
  error: () => null,
  settings: () => SETTINGS,
};
function withProvider(fn) {
  setEgressProvider(provider);
  try { return fn(); } finally { setEgressProvider(null); }
}
const activeTarget = (slug = "egenv", meta = {}) => withProvider(() => resolveRuntime(slug, { platform: "slack", channelId: "C_EGENV", ...meta }, { settings: SETTINGS }));
const inactiveTarget = (slug = "egenv-off") => resolveRuntime(slug, { platform: "slack", channelId: "C_EGENV" }, { settings: { ...SETTINGS, egressMode: "bridge" } });

test("egressEnv: {} unless the proxy is the target's egress; then the proxy, NO_PROXY, the CA everywhere and CG_EGRESS", () => {
  assert.deepEqual(egressEnv(null), {});
  assert.deepEqual(egressEnv(inactiveTarget()), {});
  const env = egressEnv(activeTarget());
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) assert.equal(env[name], "http://127.0.0.1:3128");
  assert.equal(EGRESS_PROXY_URL, "http://127.0.0.1:3128");
  assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1");
  assert.equal(env.no_proxy, "localhost,127.0.0.1,::1");
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
  for (const name of ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "PIP_CERT", "NPM_CONFIG_CAFILE", "CARGO_HTTP_CAINFO", "AWS_CA_BUNDLE", "DENO_CERT"]) {
    assert.equal(env[name], CA, name);
  }
  assert.equal(EGRESS_CA_ENV_NAMES.length, 10);
  assert.equal(env.CG_EGRESS, "proxy");
  assert.equal(env.ALL_PROXY, undefined);
  assert.equal(env.all_proxy, undefined);
});

test("every egress variable is a reserved name: a channel secret can never set or shadow one", () => {
  for (const name of [...EGRESS_ENV_NAMES, "SSL_CERT_DIR"]) {
    assert.equal(isReservedEnvName(name), true, `${name} must be reserved`);
    if (/^[A-Z][A-Z0-9_]*$/.test(name)) assert.throws(() => assertValidEnvName(name), /reserved/);
  }
});

test("create argv carries the proxy env and --network none; the legacy bridge carries neither", () => {
  const caps = { uidStrategy: "keep-id", supportsInit: true };
  const t = activeTarget("egenv-create");
  const args = buildCreateArgs(t, caps, { fingerprint: "c1-x" });
  const envArgs = args.filter((_, i) => args[i - 1] === "-e");
  for (const pair of ["HTTPS_PROXY=http://127.0.0.1:3128", "http_proxy=http://127.0.0.1:3128", `SSL_CERT_FILE=${CA}`, `GIT_SSL_CAINFO=${CA}`, "NODE_USE_ENV_PROXY=1", "CG_EGRESS=proxy"]) {
    assert.ok(envArgs.includes(pair), pair);
  }
  assert.equal(args[args.indexOf("--network") + 1], "none");

  const legacy = buildCreateArgs(inactiveTarget("egenv-legacy"), caps, { fingerprint: "c1-x" });
  assert.equal(legacy[legacy.indexOf("--network") + 1], "bridge");
  assert.ok(!legacy.some((a) => typeof a === "string" && (a.startsWith("HTTPS_PROXY=") || a.startsWith("CG_EGRESS="))));
});

test("a raw-socket channel keeps the proxy env on the bridge network", () => {
  const t = activeTarget("egenv-raw", { rawNetwork: true });
  assert.equal(t.container.network, "bridge");
  assert.equal(t.container.egress.active, true);
  assert.equal(egressEnv(t).HTTPS_PROXY, "http://127.0.0.1:3128");
});

test("the exec env-file FORCES the proxy values over a host HTTPS_PROXY and drops ALL_PROXY", () => {
  const host = { HTTPS_PROXY: "http://corp-proxy:8080", https_proxy: "http://corp-proxy:8080", ALL_PROXY: "socks5://corp:1080", all_proxy: "socks5://corp:1080", NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem", KEEP: "1" };
  const env = containerRunEnv(activeTarget("egenv-exec"), host);
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:3128");
  assert.equal(env.https_proxy, "http://127.0.0.1:3128");
  assert.equal(env.NODE_EXTRA_CA_CERTS, CA);
  assert.equal(env.ALL_PROXY, undefined);
  assert.equal(env.all_proxy, undefined);
  assert.equal(env.KEEP, "1");
  // Not active: the caller's env passes as before (legacy bridge mode).
  const legacy = containerRunEnv(inactiveTarget("egenv-exec-legacy"), host);
  assert.equal(legacy.HTTPS_PROXY, "http://corp-proxy:8080");
  assert.equal(legacy.ALL_PROXY, "socks5://corp:1080");
  assert.deepEqual(applyEgressEnv({ A: "1" }, null), { A: "1" });
});

test("buildClaudeEnv: the proxy + CA are in the gateway-owned last group, over the daemon's own proxy", () => {
  const source = { PATH: "/usr/bin", HOME: "/home/daemon", HTTPS_PROXY: "http://corp-proxy:8080", ALL_PROXY: "socks5://corp:1080", NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem" };
  const t = activeTarget("egenv-claude");
  const env = buildClaudeEnv({ target: t, extraEnv: { GITHUB_TOKEN: "cgph_cabcdefghijklmnopqrstuvwxyz234567", HTTPS_PROXY: "http://evil:1" }, oauthToken: RELAY_PLACEHOLDER, browserNamespace: "cg-slack-egenv-claude" }, source);
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:3128");
  assert.equal(env.ALL_PROXY, undefined);
  assert.equal(env.NODE_EXTRA_CA_CERTS, CA);
  assert.equal(env.CG_EGRESS, "proxy");
  assert.equal(env.GITHUB_TOKEN, "cgph_cabcdefghijklmnopqrstuvwxyz234567", "the placeholder rides like any secret");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, RELAY_PLACEHOLDER);
  assert.equal(env[BROWSER_ARGS_ENV], `--proxy-server=http://127.0.0.1:3128 --ignore-certificate-errors-spki-list=${SPKI}`);

  const legacy = buildClaudeEnv({ target: inactiveTarget("egenv-claude-legacy") }, source);
  assert.equal(legacy.CG_EGRESS, undefined);
  assert.equal(legacy[BROWSER_ARGS_ENV], undefined);
});

test("buildCodexEnv: the same last group", () => {
  const source = { PATH: "/usr/bin", HTTP_PROXY: "http://corp-proxy:8080", all_proxy: "socks5://corp:1080" };
  const env = buildCodexEnv({ target: activeTarget("egenv-codex"), browserNamespace: "cg-slack-egenv-codex" }, source);
  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:3128");
  assert.equal(env.all_proxy, undefined);
  assert.equal(env.SSL_CERT_FILE, CA);
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
  assert.equal(env[BROWSER_ARGS_ENV], `--proxy-server=http://127.0.0.1:3128 --ignore-certificate-errors-spki-list=${SPKI}`);
});

test("browser env: the Chromium proxy flags only for an active plan with a CA pin", () => {
  assert.equal(browserEgressArgs(null), "");
  assert.equal(browserEgressArgs({ active: true, caSpki: "" }), "");
  assert.equal(browserEgressArgs({ active: false, caSpki: SPKI }), "");
  assert.deepEqual(browserSpawnEnv("cg-slack-x"), { AGENT_BROWSER_NAMESPACE: "cg-slack-x" });
  assert.deepEqual(browserSpawnEnv("cg-slack-x", { target: activeTarget("egenv-browser") }), {
    AGENT_BROWSER_NAMESPACE: "cg-slack-x",
    AGENT_BROWSER_ARGS: `--proxy-server=http://127.0.0.1:3128 --ignore-certificate-errors-spki-list=${SPKI}`,
  });
});
