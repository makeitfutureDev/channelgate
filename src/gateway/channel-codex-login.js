// Admin UI login for a channel or the shared gateway Codex home. The CLI owns auth.json; this module
// never returns its contents, the API key, or raw CLI output to a browser or log.
import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readCodexAuthState } from "../engines/codex-auth.js";
import { codexEngineHome } from "../config/paths.js";
import { channelCodexHome, codexAuthProcessEnv } from "./channel-codex-auth.js";
import { invalidateEngineMcps } from "./mcp-discovery.js";

const DEVICE_TIMEOUT_MS = 10 * 60_000;
const KEY_TIMEOUT_MS = 30_000;
const jobs = new Map();

function loginEnv(home) {
  return codexAuthProcessEnv(home);
}

function deviceDetails(output) {
  // Codex colors the URL and code when launched without a terminal, and newer CLIs issue
  // five-character second halves. Strip terminal controls before parsing the complete code.
  const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const code = plain.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/)?.[0] || "";
  const url = plain.match(/https:\/\/[^\s<>"']+/)?.[0] || "";
  let safeUrl = "";
  try {
    const parsed = new URL(url);
    if (["auth.openai.com", "chatgpt.com"].includes(parsed.hostname) && parsed.protocol === "https:") safeUrl = parsed.href;
  } catch { /* wait for more output */ }
  return { code, url: safeUrl };
}

function gatewayCodexHome() {
  const engineFile = path.join(codexEngineHome(), "auth.json");
  try {
    const entry = lstatSync(engineFile);
    if (entry.isFile()) return codexEngineHome();
    if (entry.isSymbolicLink()) return path.dirname(realpathSync(engineFile));
  } catch { /* the shared login has not been created yet */ }
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

async function loginStatus(jobKey, home) {
  const auth = await readCodexAuthState({ codexHome: home, hostCodexHome: home, env: {} });
  const job = jobs.get(jobKey);
  return {
    authenticated: auth.known && auth.authenticated,
    method: auth.known && auth.authenticated ? auth.method : "",
    phase: job?.phase || "idle",
    code: job?.phase === "pending" ? job.code : "",
    url: job?.phase === "pending" ? job.url : "",
    error: job?.phase === "failed" ? job.error : "",
  };
}

export const channelCodexLoginStatus = (channelId) => loginStatus(`channel:${channelId}`, channelCodexHome(channelId));
export const gatewayCodexLoginStatus = async () => {
  const status = await loginStatus("gateway", gatewayCodexHome());
  // A service-level key is a valid shared fallback when no file login exists. Never return it.
  if (!status.authenticated && process.env.OPENAI_API_KEY) return { ...status, authenticated: true, method: "api-key" };
  return status;
};

async function startLogin(jobKey, home, method, { key = "", spawnImpl = spawn, onAuthenticated = async () => {} } = {}) {
  if (!(["device", "api-key"].includes(method))) throw Object.assign(new Error("invalid sign-in method"), { statusCode: 400 });
  if (method === "api-key" && (typeof key !== "string" || !/^sk-[^\s]{10,}$/.test(key) || key.length > 8192))
    throw Object.assign(new Error("Enter an OpenAI API key"), { statusCode: 400 });
  if (jobs.get(jobKey)?.phase === "pending") throw Object.assign(new Error("sign-in already in progress"), { statusCode: 409 });
  const job = { phase: "pending", code: "", url: "", error: "", child: null };
  jobs.set(jobKey, job);
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
  } catch {
    if (jobs.get(jobKey) === job) jobs.delete(jobKey);
    throw Object.assign(new Error("Could not prepare the Codex login directory."), { statusCode: 500 });
  }
  if (jobs.get(jobKey) !== job) return loginStatus(jobKey, home);
  const args = ["login", "-c", 'cli_auth_credentials_store="file"', method === "device" ? "--device-auth" : "--with-api-key"];
  let child;
  try {
    child = spawnImpl("codex", args, { cwd: home, env: loginEnv(home), stdio: [method === "api-key" ? "pipe" : "ignore", "pipe", "pipe"] });
  } catch {
    job.phase = "failed";
    job.error = "Codex CLI could not start on the gateway host.";
    return loginStatus(jobKey, home);
  }
  job.child = child;
  let output = "";
  const collect = (chunk) => {
    if (method !== "device") return;
    output = `${output}${chunk}`.slice(-8192);
    const details = deviceDetails(output);
    if (details.code) job.code = details.code;
    if (details.url) job.url = details.url;
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  if (method === "api-key") child.stdin?.end(`${key}\n`);
  const timer = setTimeout(() => child.kill("SIGKILL"), method === "device" ? DEVICE_TIMEOUT_MS : KEY_TIMEOUT_MS);
  timer.unref?.();
  child.once("error", () => {
    clearTimeout(timer);
    job.phase = "failed";
    job.error = "Codex CLI could not start on the gateway host.";
    job.child = null;
  });
  child.once("close", async (code) => {
    clearTimeout(timer);
    job.child = null;
    job.code = "";
    job.url = "";
    if (job.phase !== "pending") return;
    if (code !== 0) {
      job.phase = "failed";
      job.error = method === "device"
        ? "ChatGPT sign-in did not complete. Check that device code sign-in is enabled, then try again."
        : "API key sign-in failed. Check the key and try again.";
      return;
    }
    try {
      const auth = await readCodexAuthState({ codexHome: home, hostCodexHome: home, env: {} });
      if (!auth.authenticated || auth.method !== (method === "device" ? "chatgpt" : "api-key")) throw new Error("credential not saved");
      await onAuthenticated();
      invalidateEngineMcps("codex", { channelId: jobKey.startsWith("channel:") ? jobKey.slice(8) : "" });
      job.phase = "complete";
    } catch {
      job.phase = "failed";
      job.error = "Codex did not save a usable login.";
    }
  });
  return loginStatus(jobKey, home);
}

export function startChannelCodexLogin(channelId, method, options) {
  if (!channelId) throw Object.assign(new Error("unknown channel"), { statusCode: 404 });
  return startLogin(`channel:${channelId}`, channelCodexHome(channelId), method, options);
}
export const startGatewayCodexLogin = (method, options) => startLogin("gateway", gatewayCodexHome(), method, options);

function cancelLogin(jobKey) {
  const job = jobs.get(jobKey);
  if (!job || job.phase !== "pending") return false;
  job.phase = "idle";
  job.code = "";
  job.child?.kill("SIGTERM");
  jobs.delete(jobKey);
  return true;
}

export const cancelChannelCodexLogin = (channelId) => cancelLogin(`channel:${channelId}`);
export const cancelGatewayCodexLogin = () => cancelLogin("gateway");
