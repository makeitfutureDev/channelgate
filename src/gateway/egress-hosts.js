// Narrow, channel-scoped raw egress grants. Human approval is supplied by the durable
// control-plane gate; neither Auto mode nor an engine can approve this mutation.
import { getChannelEntry, getChannelMeta, isAdminPrincipal, isApproved, patchChannelMeta } from "../config/store.js";
import { logChannelPolicyChange } from "../config/channel-audit.js";
import { channelMode, isAuthorized } from "./modes.js";
import { checkDestination, isValidDestinationHost } from "./egress/policy.js";
import { normalizeHost } from "./egress/rules.js";
import { isValidRuleHost, assertValidEgressRawHosts } from "./egress/catalog-rules.js";

export async function isChannelWorker(channelId, slug, userId) {
  if (!userId) return false;
  const entry = await getChannelEntry(channelId);
  const meta = await getChannelMeta(slug);
  if (!entry || entry.slug !== slug || !meta || meta.channelId !== channelId || channelMode(meta) === "read") return false;
  return isAuthorized(meta, userId, Boolean(entry.isDM), {
    isAdminUser: await isAdminPrincipal(userId), isApprovedUser: await isApproved(userId),
  });
}

export async function prepareEgressHost(ctx, value, { lookup } = {}) {
  if (!ctx.principalTrusted || !(await isChannelWorker(ctx.channelId, ctx.slug, ctx.createdBy))) {
    throw new Error("Only an authorized channel member with write access can request SSH egress.");
  }
  const meta = await getChannelMeta(ctx.slug);
  if (meta.allowNetwork !== true) throw new Error("Network access is off for this channel.");
  const host = normalizeHost(value);
  if (!isValidDestinationHost(host) || !isValidRuleHost(host)) throw new Error("Use one exact hostname, without wildcards, a URL, or a port.");
  const result = await checkDestination({ hostname: host, port: 22, mode: "on", rawPassthrough: [{ host, port: 22 }], lookup });
  if (!result.ok) throw new Error(result.reason);
  assertValidEgressRawHosts([...(meta.egressRawHosts || []), host]);
  return { host, alreadyAllowed: (meta.egressRawHosts || []).includes(host) };
}

export async function addApprovedEgressHost(ctx, value, options) {
  const { host } = await prepareEgressHost(ctx, value, options);
  if (!(await isChannelWorker(ctx.channelId, ctx.slug, ctx.createdBy))) throw new Error("The requester no longer has write access in this channel.");
  let before;
  const after = await patchChannelMeta(ctx.slug, (current) => {
    if (!current || current.channelId !== ctx.channelId || channelMode(current) === "read" || current.allowNetwork !== true) {
      throw new Error("This channel no longer permits SSH egress.");
    }
    before = current;
    return { egressRawHosts: assertValidEgressRawHosts([...(current.egressRawHosts || []), host]) };
  });
  await logChannelPolicyChange({ channelId: ctx.channelId, slug: ctx.slug, actor: ctx.createdBy, before, after, source: "mcp" });
  return host;
}
