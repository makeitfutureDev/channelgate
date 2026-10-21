// Short-lived, metadata-only inventory for Slack's private Settings views. Credentials form a
// digest, never a cache value/key in cleartext. Every caller still authorizes its viewer live.
import { createHash } from "node:crypto";
import { loadComposioInventory } from "../gateway/composio-inventory.js";
import { getComposioMode, getComposioSdkApiKey, getDefaultComposioToken } from "../config/settings.js";
import { composioUrl } from "../gateway/mcp-catalog.js";

const currentConfig = () => ({ mode: getComposioMode(), sdkApiKey: getComposioSdkApiKey(),
  defaultToken: getDefaultComposioToken(), url: composioUrl(), workspaceId: process.env.CG_SLACK_TEAM_ID || "" });

export function createSettingsComposioCache({ load = loadComposioInventory, config = currentConfig,
  now = Date.now, ttlMs = 60_000, maxEntries = 32 } = {}) {
  const entries = new Map();
  const describe = (request) => {
    const resolved = config();
    const record = request.record || {};
    const key = createHash("sha256").update(JSON.stringify([request.kind, request.id,
      record.composioToken || "", Boolean(record.noDefaultTokens), Boolean(record.isDM || record.type === "im"), resolved])).digest("hex");
    return { key, resolved };
  };
  const fresh = (key) => {
    const entry = entries.get(key);
    if (entry && !entry.promise && entry.expires <= now()) { entries.delete(key); return undefined; }
    return entry;
  };
  return {
    key: (request) => describe(request).key,
    peek(request) { return fresh(describe(request).key)?.result; },
    invalidate(request) { entries.delete(describe(request).key); },
    async load(request, { force = false } = {}) {
      const { key, resolved } = describe(request);
      const existing = fresh(key);
      if (existing?.promise) return existing.promise;
      if (!force && existing?.result) return existing.result;
      const entry = { expires: 0, result: undefined, promise: null };
      entry.promise = Promise.resolve().then(() => load(request, { config: resolved })).catch(() => ({
        mode: resolved.mode === "sdk" ? "sdk" : "personal", source: "none", state: "unavailable",
        message: "Composio connections could not be loaded. Try refreshing.", accounts: [],
      })).then((result) => {
        entry.result = result;
        entry.expires = now() + ttlMs;
        entry.promise = null;
        return result;
      });
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      return entry.promise;
    },
  };
}

export const settingsComposioCache = createSettingsComposioCache();
