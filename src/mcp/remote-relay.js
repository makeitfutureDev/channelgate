// The daemon-side relay behind the `remote-mcp` socket service (src/mcp/socket-server.js): an MCP
// Server on the container's socket whose tools are a header-bearing REMOTE MCP server (Composio
// user/agent, the toolboxes) dialled by the daemon with the real credential. The container side is
// the ordinary socket bridge holding only the signed run capability, so the credential never
// crosses into a container — not in a config file, not in an env var, not in a bundle.
//
// Modelled on the Enterprise composio-sdk bridge (src/ee/composio-sdk-bridge.js), which is the same
// idea for SDK sessions: connect a Client upstream, serve tools/list + tools/call downstream, and
// re-run the caller's authorization on EVERY forwarded request so an expired or revoked grant stops
// working mid-connection rather than at the next hello.
//
// Every failure surfaced from here is deliberately generic: an upstream error can quote a request
// header or a URL, and the refusal line reaches the engine's MCP log inside the container.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

// The upstream ceiling for ONE forwarded request. The engine owns the real tool timeout (Claude's
// MCP_TOOL_TIMEOUT, Codex's tool_timeout_sec) and cancels through the relay when it gives up —
// which aborts the upstream call via the handler's signal — so this only has to be no tighter than
// either of them. Progress from upstream resets it.
export const RELAY_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const CLIENT_INFO = { name: "channelgate-remote-relay", version: "1.0.0" };

/** An https URL with no embedded credentials, or a throw. The URL itself is never echoed. */
export function validateRemoteUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("remote MCP relay requires a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("remote MCP relay requires an HTTPS URL");
  if (url.username || url.password) throw new Error("remote MCP relay refuses credentials in the URL");
  return url;
}

// The standard client pattern: Streamable HTTP first, and the legacy HTTP+SSE transport only when
// the server answered the Streamable initialize with a 4xx (the "this endpoint does not speak
// Streamable HTTP" signal: 404/405 on the POST). Anything else — a network failure, a 5xx — is a
// real failure and is not retried on a second transport. `fetch` is injectable for tests only.
export async function connectRemoteClient({ url, headers = {}, fetch = undefined } = {}) {
  const target = validateRemoteUrl(url);
  const requestInit = { headers: { ...headers } };
  const streamable = new Client(CLIENT_INFO, { capabilities: {} });
  try {
    await streamable.connect(new StreamableHTTPClientTransport(target, { requestInit, ...(fetch ? { fetch } : {}) }));
    return streamable;
  } catch (error) {
    await streamable.close().catch(() => {});
    const status = Number(error?.code);
    if (!(status >= 400 && status < 500)) throw new Error("remote MCP server unavailable");
  }
  const sse = new Client(CLIENT_INFO, { capabilities: {} });
  try {
    await sse.connect(new SSEClientTransport(target, {
      requestInit,
      ...(fetch ? { fetch, eventSourceInit: { fetch } } : {}),
    }));
    return sse;
  } catch {
    await sse.close().catch(() => {});
    throw new Error("remote MCP server unavailable");
  }
}

// Forwarded request options: the engine's cancellation aborts the upstream call, and upstream
// progress is re-emitted downstream under the ENGINE's progress token (the client allocates its
// own token for the upstream leg, so the engine's must not be forwarded as-is).
function forwardOptions(params, extra) {
  const progressToken = params?._meta?.progressToken;
  const options = { timeout: RELAY_REQUEST_TIMEOUT_MS, resetTimeoutOnProgress: true };
  if (extra?.signal) options.signal = extra.signal;
  if (progressToken !== undefined && typeof extra?.sendNotification === "function") {
    options.onprogress = (progress) => {
      extra.sendNotification({ method: "notifications/progress", params: { ...progress, progressToken } }).catch?.(() => {});
    };
  }
  return options;
}

function upstreamParams(params) {
  if (!params?._meta || params._meta.progressToken === undefined) return params;
  const { progressToken: _dropped, ...meta } = params._meta;
  const out = { ...params };
  if (Object.keys(meta).length) out._meta = meta;
  else delete out._meta;
  return out;
}

export const RELAY_REQUEST_FAILED = "remote MCP request failed";
export const RELAY_NOT_AUTHORIZED = "remote MCP is not authorized for this run";

// What of an upstream failure may reach the container. A JSON-RPC error the REMOTE SERVER answered
// with (McpError — including the SDK's own fixed-text timeout and connection-closed errors) is
// protocol, and passes unchanged so the engine can act on it. Anything else is transport — the
// SDK builds e.g. "Error POSTing to endpoint: <response body>", which can quote an upstream page, a
// header or a URL — and becomes one fixed sentence.
function scrubUpstreamError(error) {
  if (error instanceof McpError) throw error;
  throw new McpError(ErrorCode.InternalError, RELAY_REQUEST_FAILED);
}

function authorized(authorize) {
  try {
    authorize();
  } catch {
    throw new McpError(ErrorCode.InvalidRequest, RELAY_NOT_AUTHORIZED);
  }
}

/** The two forwarded methods, each re-authorized before it leaves the daemon. */
export function createRelayHandlers(remote, authorize) {
  if (typeof authorize !== "function") throw new Error("remote MCP relay requires an authorization check");
  const forward = async (method, schema, params, extra) => {
    authorized(authorize);
    try {
      return await remote.request({ method, params: upstreamParams(params) }, schema, forwardOptions(params, extra));
    } catch (error) {
      return scrubUpstreamError(error);
    }
  };
  return {
    listTools: (params, extra) => forward("tools/list", ListToolsResultSchema, params, extra),
    callTool: (params, extra) => forward("tools/call", CallToolResultSchema, params, extra),
  };
}

/**
 * Relay one remote MCP server onto `transport`. `authorize()` must throw when the grant no longer
 * holds; it runs once before anything is dialled and again on every forwarded request. `remote`
 * (a connected Client-like object) or `connect` may be injected by tests; production dials
 * `url` with `headers` through connectRemoteClient.
 */
export async function runRemoteRelay({ url, headers = {}, transport, authorize, remote = null, connect = connectRemoteClient } = {}) {
  if (typeof authorize !== "function") throw new Error("remote MCP relay requires an authorization check");
  if (!transport) throw new Error("remote MCP relay requires a transport");
  authorize();
  validateRemoteUrl(url);
  const client = remote || await connect({ url, headers });
  const handlers = createRelayHandlers(client, authorize);
  const instructions = typeof client.getInstructions === "function" ? client.getInstructions() : undefined;
  const server = new Server(
    { name: "channelgate-remote-relay", version: "1.0.0" },
    { capabilities: { tools: {} }, ...(typeof instructions === "string" && instructions ? { instructions } : {}) },
  );
  server.setRequestHandler(ListToolsRequestSchema, (request, extra) => handlers.listTools(request.params, extra));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => handlers.callTool(request.params, extra));
  // One upstream connection per downstream connection: whichever side ends, the other goes too.
  let closed = false;
  const closeBoth = () => {
    if (closed) return;
    closed = true;
    server.close?.().catch?.(() => {});
    client.close?.()?.catch?.(() => {});
  };
  server.onclose = closeBoth;
  client.onclose = closeBoth;
  try {
    await server.connect(transport);
  } catch (error) {
    closeBoth();
    throw error;
  }
  return { server, client, close: closeBoth };
}
