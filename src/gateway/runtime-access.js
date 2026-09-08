// The resolved target is the one source of access facts for both the operating guide and each
// attempt prompt. Never infer mounts from the author role or from a previous conversation turn.
import path from "node:path";
import { realpathSync } from "node:fs";
import { gatewayRoot, dbFile } from "../config/paths.js";

function canonicalHostPath(value) {
  try { return realpathSync(value); } catch { return path.resolve(value); }
}

function containsPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

// Describe reachability from resolved mounts without disclosing an unmounted host path. This
// is explanatory metadata, not an authorization decision or a new source of mount policy.
function hostPathMounted(mounts, hostPath) {
  const candidate = canonicalHostPath(hostPath);
  return mounts.some((mount) => {
    if (!["bind", "bind-file"].includes(mount.type) || !path.isAbsolute(mount.source || "") || !path.isAbsolute(mount.target || "")) return false;
    const source = canonicalHostPath(mount.source);
    if (mount.type === "bind-file" ? source !== candidate : !containsPath(source, candidate)) return false;
    const containerPath = path.join(mount.target, path.relative(source, candidate));
    return !mounts.some((mask) => mask.kind === "mask" && path.isAbsolute(mask.target || "")
      && containsPath(mount.target, mask.target) && containsPath(mask.target, containerPath));
  });
}

export function gatewayStoreAccessNote(target) {
  const mounts = target?.container?.mounts;
  const state = Array.isArray(mounts)
    ? `Host gateway runtime directory: **${hostPathMounted(mounts, gatewayRoot()) ? "mounted" : "not mounted"}**. Host gateway database: **${hostPathMounted(mounts, dbFile()) ? "mounted" : "not mounted"}**.`
    : "Host gateway runtime directory and database visibility are unknown because no resolved mount list was supplied.";
  return state + " Container-local /opt/channelgate and /home/agent configuration or engine state, and parent directory scaffolding around a bind mount, are not evidence of access to the host gateway store. Base any access answer on the resolved mount facts above; a mounted path still follows this attempt's tool permissions. Never print credentials or database contents as proof.";
}

function cleanModeNote(clean) {
  if (clean === true) {
    return "Clean mode for this attempt: **enabled**. The gateway intentionally omits all MCP servers (including gateway control, composio-user and composio-agent), optional organization/channel/personal skills, injected channel-memory recall, and per-channel environment secrets. When asked about those missing capabilities, explain that Clean mode makes these capabilities unavailable in this run. This is not a broken connection, missing login, or configuration fault; do not suggest reconnecting accounts to fix the deliberate omission. The gateway-usage operating guide and engine-bundled baseline tools may remain. Clean mode does not itself change the resolved mounts or establish network isolation.";
  }
  if (clean === false) {
    return "Clean mode for this attempt: **disabled**. Clean mode is not suppressing optional capabilities for this attempt. This does not prove that any optional account is configured or connected; inspect the actually exposed tools and their results before making that claim.";
  }
  return "Clean mode for this attempt is unknown because the resolved run mode was not supplied. Do not infer it from missing tools alone.";
}

function networkPolicyNote(allowNetwork) {
  if (typeof allowNetwork !== "boolean") {
    return "Network policy for this attempt is unknown because the resolved policy was not supplied. Do not infer network permission from earlier turns or successful requests.";
  }
  const policy = allowNetwork
    ? "Outbound requests are permitted by the channel network switch, subject to this attempt's other tool permissions and the user's requested scope. There is no per-domain allow-list."
    : "Do not make outbound requests. When a request needs the network, explain that the current policy is off and that no fresh request was made. Do not present an earlier response as a fresh network result.";
  return `Network policy for THIS attempt: **${allowNetwork ? "on" : "off"}**. This current network policy supersedes earlier turns and cached results. ${policy} The switch is advisory, not container egress enforcement: the container remains on the bridge network, and an engine may impose its own additional restrictions. An off policy does not prove that a connection is technically blocked.`;
}

export function containerAccessNote(target) {
  if (!Array.isArray(target?.container?.mounts)) {
    return "**Container access:** no resolved runtime target was supplied at prompt/guide construction. Do not infer host access from the author's role; check the current runtime before claiming a path is mounted or absent.";
  }
  const homes = target.container.mounts.filter((m) => m.kind === "operator-home").map((m) => m.target);
  const setting = target.settings?.fullAccessHome === true ? "on" : "off";
  const access = homes.length
    ? `This channel's resolved runtime includes the operator-home mount at ${homes.map((home) => JSON.stringify(home)).join(", ")}. Every admitted author can read that mounted home; write-capable bypass tools still require an admin author in Admin mode.`
    : "This channel's resolved runtime has no operator-home mount. The working folder, clean workspace and artifacts remain its host directory mounts; the author's admin role alone adds no mount.";
  return `**Container access for this run:** gateway setting \`containerFullAccessHome\` is **${setting}**. ${access} Switching this channel to Admin/Full-access qualifies it for the operator-home mount on the next resolved run ONLY while that gateway switch is on; with the switch off, Admin adds no home mount. The container remains the filesystem/process boundary. \`$HOME\` and \`~\` still refer to the channel's own home volume, not the operator's home. See the \`gateway-usage\` skill's \`references/administration.md\` for the boundary and the optional grant.`;
}

export function runtimeAccessPreamble(target, { clean, allowNetwork } = {}) {
  return "[Gateway container access for THIS attempt]\n"
    + "These current access facts supersede earlier turns and generic claims about host isolation. "
    + "Answer access questions from this resolved runtime, even when the conversation previously said otherwise.\n"
    + containerAccessNote(target) + "\n"
    + gatewayStoreAccessNote(target) + "\n"
    + "Respect the user's requested scope when checking access. For requests limited to existence, metadata or permission checks, use resolved mount facts and non-mutating metadata checks only. Do not read file contents or create, modify, or delete probe files, even temporarily. If metadata cannot establish write access, report it as unverified; do not upgrade an access-check request into a write test.\n"
    + cleanModeNote(clean) + "\n"
    + networkPolicyNote(allowNetwork) + "\n"
    + "Environment secrets, when injected into a run, are usable by its process and CLI. Write-only means masked listing/reveal surfaces and redacted outputs; it does not mean the process cannot read its environment. Do not print secret values.\n"
    + "[End gateway container access]\n\n";
}
