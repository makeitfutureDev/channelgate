// Local stdio → remote Streamable HTTP bridge for Composio SDK sessions. The engine receives only
// this script path plus a non-secret session URL. This child reads the organization SDK key from
// gateway settings itself, so the key never appears in Claude config, Codex argv, or channel files.
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getComposioSdkApiKey } from "../config/settings.js";

export function validateSessionUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:") throw new Error("Composio SDK bridge requires an HTTPS URL");
  const host = url.hostname.toLowerCase();
  if (host !== "composio.dev" && !host.endsWith(".composio.dev")) {
    throw new Error("Composio SDK bridge requires a hosted Composio URL");
  }
  if (!url.pathname.includes("/tool_router/") || !url.pathname.endsWith("/mcp")) {
    throw new Error("Composio SDK bridge requires a session MCP URL");
  }
  return url;
}

export function createToolHandlers(remote) {
  return {
    listTools: () => remote.listTools(),
    callTool: (params) => remote.callTool(params),
  };
}

export async function runBridge(sessionUrl, {
  apiKey = getComposioSdkApiKey(),
  remote = null,
  transport = new StdioServerTransport(),
} = {}) {
  const url = validateSessionUrl(sessionUrl);
  if (!apiKey) throw new Error("Composio SDK key is not configured");

  const client = remote || new Client(
    { name: "channelgate-composio-bridge", version: "1.0.0" },
    { capabilities: {} }
  );
  if (!remote) {
    await client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { "x-api-key": apiKey } },
    }));
  }

  const handlers = createToolHandlers(client);
  const server = new Server(
    { name: "channelgate-composio", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, () => handlers.listTools());
  server.setRequestHandler(CallToolRequestSchema, (request) => handlers.callTool(request.params));
  await server.connect(transport);
  return { server, client };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runBridge(process.argv[2]).catch(() => {
    // Deliberately fixed text: upstream errors may contain request headers or URLs. The engine
    // needs only an unavailable-server signal; detailed SDK diagnostics stay daemon-side.
    console.error("[composio-sdk-bridge] connection failed");
    process.exitCode = 1;
  });
}
