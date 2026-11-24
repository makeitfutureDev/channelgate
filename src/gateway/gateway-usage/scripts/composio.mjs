#!/usr/bin/env node
// ChannelGate Composio script relay client (SDK mode). No Composio API key is needed: the gateway
// daemon executes every call as this turn's identity. Dependency-free (Node built-ins only).
//
// As a library (copy or import this file; pass the grant path from the turn's prompt):
//   import { connectComposio } from "<this file>";
//   const composio = await connectComposio({ grant: process.env.CG_COMPOSIO_GRANT });
//   await composio.whoami();
//   await composio.accounts({ identity: "user", toolkit: "gmail" });
//   const r = await composio.execute({ identity: "user", tool: "GMAIL_FETCH_EMAILS", arguments: { max_results: 5 } });
//   composio.close();
//
// As a CLI:
//   node composio.mjs --grant <file> whoami
//   node composio.mjs --grant <file> accounts --identity user --toolkit gmail
//   node composio.mjs --grant <file> schema GMAIL_FETCH_EMAILS
//   node composio.mjs --grant <file> execute GMAIL_FETCH_EMAILS --identity user --args '{"max_results":5}' [--account ca_…]
//   node composio.mjs --grant <file> users [--toolkit gmail]          (admin, Admin-mode channel)
//   node composio.mjs --grant <file> execute SLUG --user-id <composio user id> --args '{…}'   (admin)
import net from "node:net";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export async function connectComposio({ grant = process.env.CG_COMPOSIO_GRANT || "" } = {}) {
  if (!grant) throw new Error("No Composio grant: pass the grant file named in this turn's prompt (--grant or CG_COMPOSIO_GRANT).");
  const { socket: socketPath, capability } = JSON.parse(readFileSync(grant, "utf8"));
  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.write(`${JSON.stringify({ channelgate: "hello", v: 1, service: "composio-exec", cap: capability, framed: true })}\n`);
  let buffer = "";
  let ready = null;
  let nextId = 1;
  const pending = new Map();
  const failAll = (error) => { for (const { reject } of pending.values()) reject(error); pending.clear(); };
  const readyPromise = new Promise((resolve, reject) => { ready = { resolve, reject }; });
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const frame = JSON.parse(line);
      if (frame.channelgate === "ready") { ready?.resolve(); ready = null; continue; }
      if (frame.channelgate === "error") { const e = new Error(`Composio relay refused: ${frame.reason}`); ready?.reject(e); ready = null; failAll(e); continue; }
      const entry = pending.get(frame.id);
      if (!entry) continue;
      pending.delete(frame.id);
      if (frame.ok) entry.resolve(frame.result);
      else entry.reject(new Error(frame.error));
    }
  });
  socket.on("close", () => { const e = new Error("Composio relay connection closed"); ready?.reject(e); ready = null; failAll(e); });
  socket.on("error", (e) => failAll(e));
  await readyPromise;
  const call = (op, body = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.write(`${JSON.stringify({ id, op, ...body })}\n`);
  });
  return {
    whoami: () => call("whoami"),
    accounts: (options = {}) => call("accounts", options),
    users: (options = {}) => call("users", options),
    schema: (tool) => call("schema", { tool }),
    execute: (options) => call("execute", options),
    close: () => socket.end(),
  };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
    else out._.push(a);
  }
  return out;
}

async function cli() {
  const args = parseArgs(process.argv.slice(2));
  const [op, tool] = args._;
  const composio = await connectComposio({ grant: typeof args.grant === "string" ? args.grant : undefined });
  const who = {
    ...(typeof args.identity === "string" ? { identity: args.identity } : {}),
    ...(typeof args["user-id"] === "string" ? { userId: args["user-id"] } : {}),
  };
  try {
    let result;
    if (op === "whoami") result = await composio.whoami();
    else if (op === "accounts") result = await composio.accounts({ ...who, ...(typeof args.toolkit === "string" ? { toolkit: args.toolkit } : {}) });
    else if (op === "users") result = await composio.users(typeof args.toolkit === "string" ? { toolkit: args.toolkit } : {});
    else if (op === "schema") result = await composio.schema(tool);
    else if (op === "execute") {
      result = await composio.execute({
        ...who, tool,
        arguments: typeof args.args === "string" ? JSON.parse(args.args) : {},
        ...(typeof args.account === "string" ? { account: args.account } : {}),
        ...(typeof args.version === "string" ? { version: args.version } : {}),
      });
    } else throw new Error("Usage: composio.mjs --grant <file> whoami | accounts | users | schema <TOOL> | execute <TOOL> --identity user|agent --args '{…}'");
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    composio.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
