// The write side of custom MCP connections (src/gateway/custom-mcps.js holds the rules): add,
// update and remove one entry on a channel or on a person, then cut that one server out of every
// live relay grant so a replaced or removed token stops working at the relay's next request.
// Every surface (the admin UI routes today) goes through here, so validation, the public-address
// check and the audit line cannot differ between them. Audit rows carry the name and the URL's
// host — never the token.
import { getUser, patchChannelMeta, setUser } from "../config/store.js";
import { logEvent } from "../util/logger.js";
import { revokeRemoteMcpServer } from "../mcp/remote-mcp-registry.js";
import {
  assertPublicCustomMcpUrl,
  customMcpServerName,
  listCustomMcps,
  normalizeCustomMcpName,
  patchCustomMcps,
} from "./custom-mcps.js";

function hostOf(url) {
  try { return new URL(url).host; } catch { return ""; }
}

/** Add or update one of a channel's custom MCP servers. Returns the masked list. */
export async function saveChannelCustomMcp(slug, { name, url, token } = {}, { actor = "", lookup } = {}) {
  const checkedUrl = await assertPublicCustomMcpUrl(url, lookup ? { lookup } : {});
  const saved = await patchChannelMeta(slug, (existing) => ({
    customMcps: patchCustomMcps(existing?.customMcps, { set: { name, url: checkedUrl, token }, actor }),
  }));
  const stored = normalizeCustomMcpName(name);
  revokeRemoteMcpServer((meta) => meta.slug === slug, customMcpServerName("channel", stored));
  logEvent("channel_custom_mcp_set", { slug, name: stored, host: hostOf(checkedUrl), actor });
  return listCustomMcps(saved?.customMcps, "channel");
}

/** Remove one of a channel's custom MCP servers. Returns the masked list. */
export async function removeChannelCustomMcp(slug, name, { actor = "" } = {}) {
  const stored = normalizeCustomMcpName(name);
  const saved = await patchChannelMeta(slug, (existing) => ({
    customMcps: patchCustomMcps(existing?.customMcps, { remove: stored }),
  }));
  revokeRemoteMcpServer((meta) => meta.slug === slug, customMcpServerName("channel", stored));
  logEvent("channel_custom_mcp_removed", { slug, name: stored, actor });
  return listCustomMcps(saved?.customMcps, "channel");
}

/** A person's own custom MCP servers, masked. */
export async function listUserCustomMcps(userId) {
  return listCustomMcps((await getUser(userId))?.customMcps, "user");
}

/** Add or update one of a person's own custom MCP servers. Returns the masked list. */
export async function saveUserCustomMcp(userId, { name, url, token } = {}, { actor = "", lookup } = {}) {
  if (!userId) throw new Error("No user to change.");
  const checkedUrl = await assertPublicCustomMcpUrl(url, lookup ? { lookup } : {});
  const next = patchCustomMcps((await getUser(userId))?.customMcps, { set: { name, url: checkedUrl, token }, actor: actor || userId });
  const saved = await setUser(userId, { customMcps: next });
  const stored = normalizeCustomMcpName(name);
  revokeRemoteMcpServer((meta) => meta.authorId === userId, customMcpServerName("user", stored));
  logEvent("user_custom_mcp_set", { user: userId, name: stored, host: hostOf(checkedUrl), actor: actor || userId });
  return listCustomMcps(saved.customMcps, "user");
}

/** Remove one of a person's own custom MCP servers. Returns the masked list. */
export async function removeUserCustomMcp(userId, name, { actor = "" } = {}) {
  if (!userId) throw new Error("No user to change.");
  const stored = normalizeCustomMcpName(name);
  const next = patchCustomMcps((await getUser(userId))?.customMcps, { remove: stored });
  const saved = await setUser(userId, { customMcps: next });
  revokeRemoteMcpServer((meta) => meta.authorId === userId, customMcpServerName("user", stored));
  logEvent("user_custom_mcp_removed", { user: userId, name: stored, actor: actor || userId });
  return listCustomMcps(saved.customMcps, "user");
}
