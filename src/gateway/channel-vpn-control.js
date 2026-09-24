// The sole chat/web control path: fixed helper + channel identity, never caller-supplied
// commands, paths, profile content or credentials. Provisioning stays operator-only.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getChannelEntry, getChannelMeta } from "../config/store.js";
import { listChannelEnv } from "../config/channel-env.js";
import { gatewayRoot } from "../config/paths.js";
import { logEvent } from "../util/logger.js";
import { acquireKeyedLock } from "../util/keyed-lock.js";
import { isVpnFailureClass, runCommand, SECRET_REFS, vpnFailureMessage } from "./vpn-service.js";

const helper = fileURLToPath(new URL("../../scripts/channel-vpn.mjs", import.meta.url));
const states = new Set(["off", "starting", "on", "stopping", "failed"]);
const UNCONFIGURED = "VPN is not configured. An administrator must import the profile and prepare the service first.";
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });

function helperEnv() {
  const env = { CHANNELGATE_DIR: gatewayRoot() };
  for (const name of ["HOME", "USER", "LOGNAME", "PATH", "LANG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "CHANNELGATE_DB", "CG_WORKSPACE_DIR"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}

// The helper's last stdout line names a failure by fixed class; anything else is not trusted.
function helperFailureClass(stdout = "") {
  const last = String(stdout).trim().split(/\r?\n/).pop();
  try {
    const errorClass = JSON.parse(last)?.errorClass;
    return isVpnFailureClass(errorClass) ? errorClass : "";
  } catch { return ""; }
}

export function createChannelVpnControl({
  entryFor = getChannelEntry, metaFor = getChannelMeta, inventory = listChannelEnv,
  execute = (action, channelId) => runCommand(process.execPath, [helper, action, "--channel", channelId], {
    cwd: path.dirname(path.dirname(helper)), env: helperEnv(), timeoutMs: action === "status" ? 45_000 : 350_000,
  }),
  audit = logEvent,
} = {}) {
  const pending = new Map();
  const reads = new Map();

  async function context(channelId) {
    if (typeof channelId !== "string" || !/^[A-Za-z0-9:_-]{1,100}$/.test(channelId)) throw fail("Invalid channel.", 400);
    const entry = await entryFor(channelId);
    const meta = entry && await metaFor(entry.slug);
    if (!entry || !meta) throw fail("Channel is not registered.", 404);
    const configured = meta.vpnService?.version === 1;
    const names = new Set(inventory(meta).map(item => item.name));
    const refs = { ...SECRET_REFS, ...meta.vpnService?.secrets };
    // Metadata is operator-owned, but never let malformed refs become response content.
    const selected = Object.keys(SECRET_REFS).map(role => refs[role]);
    if (selected.some(name => typeof name !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(name))) throw fail("VPN secret configuration is invalid.");
    return { entry, meta, base: { configured, allowNetwork: meta.allowNetwork === true,
      missingSecrets: configured ? selected.filter(name => !names.has(name)) : [], enabled: false, running: false, busy: false } };
  }

  async function readStatus(channelId) {
    const { base } = await context(channelId);
    if (!base.configured) return { ...base, state: "unconfigured", message: UNCONFIGURED };
    let raw;
    try {
      const result = await execute("status", channelId);
      if (result.code !== 0) throw new Error("unavailable");
      raw = JSON.parse(result.stdout);
    } catch {
      return { ...base, state: "unavailable", message: "VPN status is unavailable. Check the host VPN service." };
    }
    const c = raw?.control;
    if (!c || c.available !== true || c.installed !== true) return { ...base, state: "unavailable", message: "VPN service is not installed or its service manager is unavailable. Ask an administrator to finish setup." };
    const state = states.has(c.state) ? c.state : "failed";
    const message = state === "failed" ? vpnFailureMessage(c.errorClass) : {
      on: "VPN connected. The isolated database service is ready.",
      off: "VPN is off.", starting: "VPN is connecting. The connection is not ready yet.", stopping: "VPN is stopping.",
    }[state];
    return { ...base, enabled: c.enabled === true, running: c.running === true, state, message,
      busy: pending.has(channelId) || state === "stopping" };
  }

  async function getStatus(channelId) {
    if (reads.has(channelId)) return reads.get(channelId);
    const promise = readStatus(channelId).finally(() => reads.delete(channelId));
    reads.set(channelId, promise);
    return promise;
  }

  async function setEnabled(channelId, enabled, { actor = "", source = "", authorize = async () => false } = {}) {
    if (typeof enabled !== "boolean") throw fail("enabled must be a boolean.", 400);
    if (!await authorize()) throw fail("Only this channel's managers or an administrator can control its VPN.", 403);
    const release = await acquireKeyedLock("channel-vpn-control", channelId);
    try {
      const { entry, base } = await context(channelId);
      if (!base.configured) throw fail("VPN is not configured. Ask an administrator to import the profile and prepare the service first.");
      if (enabled && !base.allowNetwork) throw fail("Turn on Network for this channel before enabling VPN.");
      if (enabled && base.missingSecrets.length) throw fail(`Missing channel Secrets: ${base.missingSecrets.join(", ")}.`);
      // A permission revoked while waiting for another operation must win at the effect boundary.
      if (!await authorize()) throw fail("Your permission to control this channel's VPN has changed.", 403);
      pending.set(channelId, enabled);
      await audit("channel_vpn_requested", { channel: channelId, slug: entry.slug, author: actor, source, enabled });
      let result;
      try { result = await execute(enabled ? "enable" : "disable", channelId); }
      catch { throw fail("Could not control the VPN service. Refresh its status before retrying.", 503); }
      if (result.code !== 0) {
        const errorClass = helperFailureClass(result.stdout);
        await audit("channel_vpn_control_failed", { channel: channelId, slug: entry.slug, author: actor, source, enabled, ...(errorClass && { errorClass }) });
        throw fail(errorClass ? vpnFailureMessage(errorClass) : "Could not change VPN state. Check the service setup and refresh its status.", 503);
      }
      pending.delete(channelId);
      // Do not return an in-flight read taken before the command, and never equate enabled with connected.
      const status = await readStatus(channelId);
      await audit("channel_vpn_controlled", { channel: channelId, slug: entry.slug, author: actor, source, enabled, state: status.state });
      return status;
    } finally { pending.delete(channelId); release(); }
  }
  return { getStatus, setEnabled };
}

// Whether this conversation has a provisioned VPN service at all. Asking costs one metadata read
// and no subprocess, which is what lets a surface render the VPN row immediately for the vast
// majority of conversations instead of scheduling a status refresh that could only ever repeat
// what this predicate already knows.
export function channelVpnConfigured(meta) {
  return meta?.vpnService?.version === 1;
}

// The status a conversation without a provisioned service always has, built without touching the
// helper — the same shape and wording readStatus returns for it. null for a configured channel,
// whose real state only the helper can answer.
export function unconfiguredChannelVpnStatus(meta) {
  if (channelVpnConfigured(meta)) return null;
  return {
    configured: false,
    allowNetwork: meta?.allowNetwork === true,
    missingSecrets: [],
    enabled: false,
    running: false,
    busy: false,
    state: "unconfigured",
    message: UNCONFIGURED,
  };
}

const controls = createChannelVpnControl();
export const getChannelVpnStatus = controls.getStatus;
export const setChannelVpnEnabled = controls.setEnabled;
