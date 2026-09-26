// The ONE place that decides the proxy and CA environment of a channel container.
//
// Why one helper: the same names ride in three places — the container's create-time env (`-e`,
// what cg-init and anything not exec'd sees), every exec's env-file (forced, so a host
// HTTPS_PROXY in the daemon's own environment can never leak in and route around the proxy), and
// the gateway-owned last group of the engine env (buildClaudeEnv / buildCodexEnv). Three copies of
// the list would drift; the first tool that read a fourth CA variable would then fail TLS in one
// spawn path only.
//
// Everything points at the in-container forwarder on 127.0.0.1:3128 (cg-egress, started by
// cg-init), which pipes each connection to the daemon's per-channel egress socket. ALL_PROXY is
// deliberately NOT set (and is removed): a SOCKS-capable client would prefer it, and there is no
// SOCKS proxy. When the proxy is not this target's egress (legacy bridge mode, the host backend, a
// daemon with no egress service) the helper returns {} and nothing changes.
import { CONTAINER_EGRESS_CA, CONTAINER_EGRESS_PORT } from "./image-paths.js";

export const EGRESS_PROXY_URL = `http://127.0.0.1:${CONTAINER_EGRESS_PORT}`;
export const EGRESS_NO_PROXY = "localhost,127.0.0.1,::1";

export const EGRESS_PROXY_ENV_NAMES = Object.freeze(["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]);
export const EGRESS_NO_PROXY_ENV_NAMES = Object.freeze(["NO_PROXY", "no_proxy"]);
// Every CA-bundle variable a common client reads: Node, OpenSSL/curl/Python ssl, requests, curl,
// git, pip, npm, cargo, the AWS SDKs and Deno.
export const EGRESS_CA_ENV_NAMES = Object.freeze([
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO",
  "PIP_CERT", "NPM_CONFIG_CAFILE", "CARGO_HTTP_CAINFO", "AWS_CA_BUNDLE", "DENO_CERT",
]);
// Removed whenever the proxy env is applied.
export const EGRESS_UNSET_ENV_NAMES = Object.freeze(["ALL_PROXY", "all_proxy"]);
// Every name the helper owns (set or unset) — the reserved-name set in channel-env.js must cover
// all of them, and a test pins that.
export const EGRESS_ENV_NAMES = Object.freeze([
  ...EGRESS_PROXY_ENV_NAMES, ...EGRESS_NO_PROXY_ENV_NAMES, "NODE_USE_ENV_PROXY", ...EGRESS_CA_ENV_NAMES, "CG_EGRESS",
  ...EGRESS_UNSET_ENV_NAMES,
]);

export function egressEnv(target) {
  if (target?.container?.egress?.active !== true) return {};
  const env = {};
  for (const name of EGRESS_PROXY_ENV_NAMES) env[name] = EGRESS_PROXY_URL;
  for (const name of EGRESS_NO_PROXY_ENV_NAMES) env[name] = EGRESS_NO_PROXY;
  // Node's built-in fetch/http honour HTTP(S)_PROXY only with this set; Claude Code, the MCP
  // bridges and most npm CLIs are Node.
  env.NODE_USE_ENV_PROXY = "1";
  for (const name of EGRESS_CA_ENV_NAMES) env[name] = CONTAINER_EGRESS_CA;
  env.CG_EGRESS = "proxy";
  return env;
}

// Apply the helper to an env map: the proxy values win, ALL_PROXY goes. Returns a new object.
export function applyEgressEnv(env, target) {
  const extra = egressEnv(target);
  if (!Object.keys(extra).length) return env;
  const out = { ...env, ...extra };
  for (const name of EGRESS_UNSET_ENV_NAMES) delete out[name];
  return out;
}
