import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MAKE_TOOLBOX_HOST = /(?:^|\.)make(?:\.celonis)?\.com$/i;
const MAKE_TOOLBOX_PATH = /^\/mcp\/server\/[A-Za-z0-9_-]+\/?$/;
const TOOL_NAME_LIMIT = 20;

export function normalizeMakeToolboxUrl(value) {
  const raw = String(value || "").trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Make toolbox URL must be a valid HTTPS server URL");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    !MAKE_TOOLBOX_HOST.test(parsed.hostname) ||
    !MAKE_TOOLBOX_PATH.test(parsed.pathname)
  ) {
    throw new Error("Make toolbox URL must be an HTTPS *.make.com or *.make.celonis.com /mcp/server/<id> URL");
  }

  return `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`;
}

export function resolveMakeToolboxRuntime({
  makeToolboxUrl = "",
  makeToolboxKey = "",
  clean = false,
} = {}) {
  const key = String(makeToolboxKey || "").trim();
  if (clean || !makeToolboxUrl || !key) return { makeToolboxUrl: "", makeToolboxKey: "" };
  try {
    return {
      makeToolboxUrl: normalizeMakeToolboxUrl(makeToolboxUrl),
      makeToolboxKey: key,
    };
  } catch {
    return { makeToolboxUrl: "", makeToolboxKey: "" };
  }
}

export function resolveMakeToolboxUpdate(current = {}, body = {}) {
  if (body.clearMakeToolbox === true) return { makeToolboxUrl: "", makeToolboxKey: "" };

  const currentUrl = String(current.makeToolboxUrl || "").trim();
  const currentKey = String(current.makeToolboxKey || "").trim();
  const url = typeof body.makeToolboxUrl === "string" ? body.makeToolboxUrl.trim() : currentUrl;
  const suppliedKey = typeof body.makeToolboxKey === "string" ? body.makeToolboxKey.trim() : "";
  const key = suppliedKey || currentKey;

  if (!url && !key) return { makeToolboxUrl: "", makeToolboxKey: "" };
  if (!url || !key) throw new Error("Make toolbox URL and key are both required");
  return {
    makeToolboxUrl: normalizeMakeToolboxUrl(url),
    makeToolboxKey: key,
  };
}

export async function listMakeToolboxTools(
  { url, key, timeoutMs = 10_000 } = {},
  { ClientClass = Client, TransportClass = StreamableHTTPClientTransport } = {},
) {
  const normalizedUrl = normalizeMakeToolboxUrl(url);
  const token = String(key || "").trim();
  if (!token) throw new Error("Make toolbox key is required");

  const boundedTimeout = Math.max(1, Math.min(Number(timeoutMs) || 10_000, 30_000));
  const client = new ClientClass(
    { name: "channelgate-make-toolbox-test", version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new TransportClass(new URL(normalizedUrl), {
    requestInit: {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(boundedTimeout),
    },
  });
  let timer;
  let timedOut = false;

  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error("Make toolbox connection timed out"));
      }, boundedTimeout);
    });
    const response = await Promise.race([
      (async () => {
        await client.connect(transport);
        return client.listTools();
      })(),
      timeout,
    ]);
    const tools = Array.isArray(response?.tools) ? response.tools : [];
    return {
      count: tools.length,
      tools: tools
        .map((tool) => String(tool?.name || "").trim())
        .filter(Boolean)
        .slice(0, TOOL_NAME_LIMIT)
        .map((name) => name.slice(0, 160)),
    };
  } catch {
    if (timedOut) throw new Error("Make toolbox connection timed out");
    throw new Error("Could not connect to the Make toolbox");
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
