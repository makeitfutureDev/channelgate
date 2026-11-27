// Narrow, channel-scoped raw egress grants. Human approval is supplied by the durable
// control-plane gate; neither Auto mode nor an engine can approve this mutation.
import { getChannelEntry, getChannelMeta, isAdminPrincipal, isApproved, patchChannelMeta } from "../config/store.js";
import { logChannelPolicyChange } from "../config/channel-audit.js";
import { channelMode, isAuthorized } from "./modes.js";
import { checkDestination, isValidDestinationHost } from "./egress/policy.js";
import { normalizeHost } from "./egress/rules.js";
import { assertValidEgressRawHosts } from "./egress/catalog-rules.js";
import {
  LOOPBACK_ALIAS, assertValidEgressPrivateHosts, containerHostFor, formatPrivateHost, parsePrivateHost, privateAddressProblem,
} from "./egress/private-hosts.js";
import { classifyAddress } from "../web/ip-policy.js";
import dns from "node:dns";
import { isIP } from "node:net";

export async function isChannelWorker(channelId, slug, userId) {
  if (!userId) return false;
  const entry = await getChannelEntry(channelId);
  const meta = await getChannelMeta(slug);
  if (!entry || entry.slug !== slug || !meta || meta.channelId !== channelId || channelMode(meta) === "read") return false;
  return isAuthorized(meta, userId, Boolean(entry.isDM), {
    isAdminUser: await isAdminPrincipal(userId), isApprovedUser: await isApproved(userId),
  });
}

export async function prepareEgressHost(ctx, value, { lookup, port } = {}) {
  if (!ctx.principalTrusted || !(await isChannelWorker(ctx.channelId, ctx.slug, ctx.createdBy))) {
    throw new Error("Only an authorized channel member with write access can request SSH egress.");
  }
  const meta = await getChannelMeta(ctx.slug);
  if (meta.allowNetwork !== true) throw new Error("Network access is off for this channel.");
  const host = normalizeHost(value);
  if (!isValidDestinationHost(host)) throw new Error("Use one exact hostname or public IP address, without wildcards, a URL, or a port.");
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("Use an integer TCP port from 1 to 65535.");
  }
  const destination = port === undefined ? host : `${host.includes(":") ? `[${host}]` : host}:${port}`;
  const checkedPort = port ?? 22;
  const result = await checkDestination({ hostname: host, port: checkedPort, mode: "on", rawPassthrough: [{ host, port: checkedPort }], lookup });
  if (!result.ok) throw new Error(result.reason);
  assertValidEgressRawHosts([...(meta.egressRawHosts || []), destination]);
  return { host, ...(port === undefined ? {} : { port }), alreadyAllowed: (meta.egressRawHosts || []).includes(destination) };
}

export async function addApprovedEgressHost(ctx, value, options) {
  const { host, port } = await prepareEgressHost(ctx, value, options);
  const destination = port === undefined ? host : `${host.includes(":") ? `[${host}]` : host}:${port}`;
  if (!(await isChannelWorker(ctx.channelId, ctx.slug, ctx.createdBy))) throw new Error("The requester no longer has write access in this channel.");
  let before;
  const after = await patchChannelMeta(ctx.slug, (current) => {
    if (!current || current.channelId !== ctx.channelId || channelMode(current) === "read" || current.allowNetwork !== true) {
      throw new Error("This channel no longer permits SSH egress.");
    }
    before = current;
    return { egressRawHosts: assertValidEgressRawHosts([...(current.egressRawHosts || []), destination]) };
  });
  await logChannelPolicyChange({ channelId: ctx.channelId, slug: ctx.slug, actor: ctx.createdBy, before, after, source: "mcp" });
  return destination;
}

// ── Admin-approved private destinations (src/gateway/egress/private-hosts.js) ─────────────────
// The requester is any channel worker; the card is clicked by an organization admin (gate tier).
// The address is resolved and PINNED here; applying the saved call resolves again and refuses
// when the answer moved, so the admin approves exactly the address shown on the card.
export async function preparePrivateHost(ctx, value, { port, address: expected, lookup } = {}) {
  if (!ctx.principalTrusted || !(await isChannelWorker(ctx.channelId, ctx.slug, ctx.createdBy))) {
    throw new Error("Only an authorized channel member with write access can request a private destination.");
  }
  const meta = await getChannelMeta(ctx.slug);
  if (meta.allowNetwork !== true) throw new Error("Network access is off for this channel.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Use an integer TCP port from 1 to 65535.");
  let host = normalizeHost(String(value ?? "").replace(/^\[|\]$/g, ""));
  if (!isValidDestinationHost(host)) throw new Error("Use one exact hostname or IP address, without wildcards, a URL, or a port.");
  let address;
  if (host === "localhost" || host === LOOPBACK_ALIAS) {
    address = expected !== undefined && classifyAddress(String(expected)) === "loopback" ? String(expected) : "127.0.0.1";
  } else if (isIP(host)) {
    address = host;
  } else {
    let answers;
    try {
      answers = await (lookup ? lookup(host, { all: true, verbatim: true }) : dns.promises.lookup(host, { all: true, verbatim: true }));
    } catch {
      throw new Error(`${host} could not be resolved from the gateway.`);
    }
    const distinct = [...new Set((Array.isArray(answers) ? answers : [answers]).map((a) => String(a?.address ?? a).toLowerCase()))];
    if (distinct.length !== 1) throw new Error(`${host} resolves to ${distinct.length} addresses (${distinct.join(", ")}); request one exact IP address instead.`);
    address = distinct[0];
  }
  address = address.toLowerCase();
  if (classifyAddress(address) === "") throw new Error(`${host} resolves to a public address; use allow_channel_ssh_host for public destinations.`);
  const problem = privateAddressProblem(address, port);
  if (problem) throw new Error(`${host} (${address}) ${problem}.`);
  if (expected !== undefined && String(expected).toLowerCase() !== address) {
    throw new Error(`${host} now resolves to ${address}, not the approved ${expected}; request it again.`);
  }
  host = containerHostFor(host, address);
  const entry = formatPrivateHost({ host, port, address });
  assertValidEgressPrivateHosts([...(meta.egressPrivateHosts || []), entry]);
  return { host, port, address, entry, alreadyAllowed: (meta.egressPrivateHosts || []).includes(entry) };
}

export async function addApprovedPrivateHost(ctx, value, options) {
  const prepared = await preparePrivateHost(ctx, value, options);
  let before;
  const after = await patchChannelMeta(ctx.slug, (current) => {
    if (!current || current.channelId !== ctx.channelId || channelMode(current) === "read" || current.allowNetwork !== true) {
      throw new Error("This channel no longer permits private egress.");
    }
    before = current;
    return { egressPrivateHosts: assertValidEgressPrivateHosts([...(current.egressPrivateHosts || []), prepared.entry]) };
  });
  await logChannelPolicyChange({ channelId: ctx.channelId, slug: ctx.slug, actor: ctx.createdBy, before, after, source: "mcp" });
  return prepared;
}

export async function removePrivateHost(ctx, value, port) {
  const host = normalizeHost(String(value ?? "").replace(/^\[|\]$/g, ""));
  const names = new Set([host, host === "localhost" || (isIP(host) && classifyAddress(host) === "loopback") ? LOOPBACK_ALIAS : host]);
  let before;
  let removed = [];
  const after = await patchChannelMeta(ctx.slug, (current) => {
    if (!current || current.channelId !== ctx.channelId) throw new Error("This channel is not available.");
    before = current;
    const keep = [];
    for (const raw of current.egressPrivateHosts || []) {
      const entry = parsePrivateHost(raw);
      if (entry && (names.has(entry.host) || entry.address === host) && (port === undefined || entry.port === port)) removed.push(raw);
      else keep.push(raw);
    }
    return { egressPrivateHosts: keep };
  });
  if (removed.length) await logChannelPolicyChange({ channelId: ctx.channelId, slug: ctx.slug, actor: ctx.createdBy, before, after, source: "mcp" });
  return removed;
}
