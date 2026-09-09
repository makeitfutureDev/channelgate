// Disposable, credential-free MCP fixture. No imports from the daemon or network calls.
import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id == null) return;
  let result;
  if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "plugin-fixture", version: "1.0.0" } };
  else if (request.method === "tools/list") result = { tools: [{ name: "plugin_echo", description: "Echo a disposable plugin acceptance marker", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }] };
  else if (request.method === "tools/call") result = { content: [{ type: "text", text: `PLUGIN-ECHO:${request.params.arguments.value}` }] };
  else if (request.method === "ping") result = {};
  else {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
