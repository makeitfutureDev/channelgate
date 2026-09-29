// Admin UI login for a channel's host-side Codex home. The CLI owns auth.json; this module
// never returns its contents, the API key, or raw CLI output to a browser or log.
import { spawn } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { buildChildEnv } from "../engines/child-env.js";
import { readCodexAuthState } from "../engines/codex-auth.js";
import { channelCodexHome } from "./channel-codex-auth.js";

const DEVICE_TIMEOUT_MS = 10 * 60_000;
const KEY_TIMEOUT_MS = 30_000;
const jobs = new Map();

function loginEnv(home) {
  const env = buildChildEnv({ CODEX_HOME: home, HOME: path.dirname(home) });
  // A login is selected by this channel's Codex home alone, never a daemon-wide key or
  // identity federation variable inherited from the service environment.
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID"]) delete env[key];
  return env;
}

function deviceDetails(output) {
  const code = output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0] || "";
  const url = output.match(/https:\/\/[^\s<>"']+/)?.[0] || "";
  let safeUrl = "";
  try {
    const parsed = new URL(url);
    if (["auth.openai.com", "chatgpt.com"].includes(parsed.hostname) && parsed.protocol === "https:") safeUrl = parsed.href;
  } catch { /* wait for more output */ }
  return { code, url: safeUrl };
}

export async function channelCodexLoginStatus(channelId) {
  const home = channelCodexHome(channelId);
  const auth = await readCodexAuthState({ codexHome: home, hostCodexHome: home, env: {} });
  const job = jobs.get(channelId);
  return {
    authenticated: auth.known && auth.authenticated,
    method: auth.known && auth.authenticated ? auth.method : "",
    phase: job?.phase || "idle",
    code: job?.phase === "pending" ? job.code : "",
    url: job?.phase === "pending" ? job.url : "",
    error: job?.phase === "failed" ? job.error : "",
  };
}

export async function startChannelCodexLogin(channelId, method, { key = "", spawnImpl = spawn, onAuthenticated = async () => {} } = {}) {
  if (!channelId) throw Object.assign(new Error("unknown channel"), { statusCode: 404 });
  if (!(["device", "api-key"].includes(method))) throw Object.assign(new Error("invalid sign-in method"), { statusCode: 400 });
  if (method === "api-key" && (typeof key !== "string" || !/^sk-[^\s]{10,}$/.test(key) || key.length > 8192))
    throw Object.assign(new Error("Enter an OpenAI API key"), { statusCode: 400 });
  if (jobs.get(channelId)?.phase === "pending") throw Object.assign(new Error("sign-in already in progress"), { statusCode: 409 });
  const home = channelCodexHome(channelId);
  const job = { phase: "pending", code: "", url: "", error: "", child: null };
  jobs.set(channelId, job);
  try {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
  } catch {
    if (jobs.get(channelId) === job) jobs.delete(channelId);
    throw Object.assign(new Error("Could not prepare this channel's Codex login directory."), { statusCode: 500 });
  }
  if (jobs.get(channelId) !== job) return channelCodexLoginStatus(channelId);
  const args = ["login", "-c", 'cli_auth_credentials_store="file"', method === "device" ? "--device-auth" : "--with-api-key"];
  let child;
  try {
    child = spawnImpl("codex", args, { cwd: home, env: loginEnv(home), stdio: [method === "api-key" ? "pipe" : "ignore", "pipe", "pipe"] });
  } catch {
    job.phase = "failed";
    job.error = "Codex CLI could not start on the gateway host.";
    return channelCodexLoginStatus(channelId);
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
      job.phase = "complete";
    } catch {
      job.phase = "failed";
      job.error = "Codex did not save a usable channel login.";
    }
  });
  return channelCodexLoginStatus(channelId);
}

export function cancelChannelCodexLogin(channelId) {
  const job = jobs.get(channelId);
  if (!job || job.phase !== "pending") return false;
  job.phase = "idle";
  job.code = "";
  job.child?.kill("SIGTERM");
  jobs.delete(channelId);
  return true;
}
