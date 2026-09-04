// Lists the optional MCP/app capabilities available to an engine:
//   claude → parse `claude mcp list`
//   codex  → ask `codex app-server` for the ACTIVE runtime MCP inventory
//
// `codex mcp list` only reports config.toml servers, while the TUI `/mcp` inventory also includes
// the OpenAI-injected `codex_apps` server. app-server's mcpServerStatus/list is the one native
// interface that sees both. Its `codex_apps` tools are grouped by the prefix before the first dot
// so the Admin UI can offer Boost.space, GitHub, Sites, etc. as separate checkboxes.
import { spawn } from "node:child_process";
import { requireAdapter } from "../engines/registry.js";
import { processFailureMessage } from "../util/process-outcome.js";

const cache = new Map(); // engine -> { ts, data }
const refreshing = new Map(); // engine -> in-flight refresh promise (dedupe concurrent refreshes)
const TTL_MS = 5 * 60 * 1000; // `claude mcp list` health-checks every server (~10s+) — cache hard
const CODEX_DISCOVERY_TIMEOUT_MS = 20_000;
const CODEX_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const CODEX_MAX_PAGES = 20;
const BUILTIN_SERVER_NAMES = new Set(["gateway", "composio", "composio-user", "makeitfuture-toolbox", "make-toolbox"]);
const SAFE_CODEX_APP_ID = /^[a-zA-Z0-9_-]{1,120}$/;
const CODEX_GROUP_LABELS = {
  boost_space: "Boost.space",
  codex_document_control: "Codex Document Control",
  github: "GitHub",
  hotline: "Hotline",
  plugin_management: "Plugin Management",
  sites: "Sites",
  skill_library: "Skill Library",
};

function run(cmd, args, timeoutMs = 25_000) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const t = setTimeout(() => {
      done = true;
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve(out);
    }, timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.on("close", () => {
      if (done) return;
      clearTimeout(t);
      resolve(out);
    });
    child.on("error", () => {
      clearTimeout(t);
      resolve(out);
    });
  });
}

function namespaceFor(name) {
  return "mcp__" + name.replace(/[^a-zA-Z0-9]+/g, "_");
}

function codexGroupLabel(prefix) {
  return CODEX_GROUP_LABELS[prefix] || prefix
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

// `--ignore-user-config` removes the host's MCP definitions. A selected optional server therefore
// needs a complete, credential-free transport definition in the per-run policy; an `enabled=true`
// bit by itself can never recreate it. Anything carrying headers/env/userinfo fails closed.
export function safeCodexMcpDefinition(server = {}) {
  const source = server.definition || server.transport || server;
  if (source.headers && Object.keys(source.headers).length) return null;
  if (source.env && Object.keys(source.env).length) return null;
  const url = String(source.url || source.httpUrl || "").trim();
  if (url) {
    try { if (new URL(url).username || new URL(url).password) return null; } catch { return null; }
    return { transport: "http", url };
  }
  const command = String(source.command || "").trim();
  if (!command) return null;
  const args = Array.isArray(source.args) && source.args.every((arg) => typeof arg === "string") ? source.args : [];
  return { transport: "stdio", command, args };
}

export function selectionFieldForEngine(engine) {
  // Each engine names its own channel-meta key; the two model MCP differently (server list vs
  // app/server policy), so this is a per-adapter fact rather than a Codex special case. This
  // decides WHERE MCP mutations persist — unknown engines fail closed, never default to Claude.
  return requireAdapter(engine || "claude").mcpMetaKey;
}

export function persistedSelectionForEngine(engine, entry) {
  if (!entry || typeof entry !== "object") return null;
  if (engine !== "codex") {
    if (!entry.name || !entry.match || !entry.namespace) return null;
    return { name: entry.name, match: entry.match, namespace: entry.namespace };
  }
  if (!entry.id || !entry.name || !entry.kind || !entry.serverName) return null;
  if (entry.kind === "tool-group") {
    if (!entry.toolPrefix) return null;
    return {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      serverName: entry.serverName,
      toolPrefix: entry.toolPrefix,
    };
  }
  if (entry.kind === "server") {
    return {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      serverName: entry.serverName,
    };
  }
  return null;
}

// Parse `claude mcp list` lines: "<name>: <target> - <status>"
function parseClaude(text) {
  const servers = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const sep = line.indexOf(": ");
    if (sep <= 0) continue; // skip headers / blanks / warnings
    const name = line.slice(0, sep).trim();
    let rest = line.slice(sep + 2).trim();
    let status = "";
    const dash = rest.lastIndexOf(" - ");
    if (dash > 0) {
      status = rest.slice(dash + 3).trim();
      rest = rest.slice(0, dash).trim();
    }
    // Strip a trailing transport annotation like " (HTTP)" / " (SSE)" that `mcp list` appends.
    const target = rest.replace(/\s*\((?:HTTP|SSE|stdio)\)\s*$/i, "").trim();
    if (!name || !target) continue;
    if (/composio/i.test(name)) continue; // both Composio identities are built in, not catalog picks
    const isHttp = /^https?:\/\//.test(target);
    servers.push({
      name,
      transport: isHttp ? "http" : "stdio",
      target,
      connected: status.includes("✔") || /Connected/.test(status),
      namespace: namespaceFor(name),
      match: isHttp ? { serverUrl: target } : { serverName: name },
    });
  }
  return servers.sort((a, b) => a.name.localeCompare(b.name));
}

// Turn app-server's status response into the small, secret-free catalog used by the gateway.
// Tool schemas, auth details, and resources are discarded; only safe connector IDs needed for
// launch policy are retained from tool metadata, and they are never persisted in channel config.
export function catalogFromCodexStatus(servers = []) {
  const entries = [];
  for (const server of Array.isArray(servers) ? servers : []) {
    const serverName = String(server?.name || "").trim();
    if (!serverName || BUILTIN_SERVER_NAMES.has(serverName)) continue;
    if (serverName === "codex_apps") {
      const grouped = new Map();
      for (const [rawName, tool] of Object.entries(server?.tools || {})) {
        const toolName = String(rawName).trim();
        const dot = toolName.indexOf(".");
        if (dot <= 0) continue;
        const prefix = toolName.slice(0, dot);
        if (!SAFE_CODEX_APP_ID.test(prefix)) continue;
        if (!grouped.has(prefix)) grouped.set(prefix, { tools: [], connectorIds: new Set() });
        const group = grouped.get(prefix);
        group.tools.push(toolName);
        const connectorId = String(tool?._meta?.connector_id || "").trim();
        if (SAFE_CODEX_APP_ID.test(connectorId)) group.connectorIds.add(connectorId);
      }
      for (const [prefix, group] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        entries.push({
          id: prefix,
          name: codexGroupLabel(prefix),
          kind: "tool-group",
          serverName: "codex_apps",
          toolPrefix: prefix,
          tools: [...new Set(group.tools)].sort(),
          connectorIds: [...group.connectorIds].sort(),
          connected: true,
          transport: "runtime",
          target: "codex_apps",
          namespace: "mcp__codex_apps",
        });
      }
      continue;
    }
    if (serverName.length > 160) continue;
    entries.push({
      id: serverName,
      name: serverName,
      kind: "server",
      serverName,
      connected: true,
      transport: "runtime",
      target: serverName,
      namespace: namespaceFor(serverName),
      definition: safeCodexMcpDefinition(server) || undefined,
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

// Query Codex's native app-server over its newline-delimited JSON protocol. This is intentionally
// dependency-injected for deterministic tests and fails closed: a cold failure yields no optional
// capabilities; the outer stale-while-revalidate cache preserves the previous good catalog.
export async function listCodexRuntimeMcps({
  spawnImpl = spawn,
  timeoutMs = CODEX_DISCOVERY_TIMEOUT_MS,
  maxMessageBytes = CODEX_MAX_MESSAGE_BYTES,
  failClosed = true,
} = {}) {
  let child;
  let timer;
  let buffer = "";
  let stderr = "";
  let settled = false;
  let nextId = 1;
  const pending = new Map();

  const failPending = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  try {
    child = spawnImpl("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    const failed = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Codex MCP discovery timed out")), Math.max(1, timeoutMs));
      timer.unref?.();
      child.on?.("error", (error) => reject(new Error(processFailureMessage("Codex MCP discovery", {
        spawnError: error,
        diagnostic: stderr,
      }))));
      child.on?.("close", (code, signal) => {
        if (!settled && (code !== 0 || signal)) {
          reject(new Error(processFailureMessage("Codex MCP discovery", { code, signal, diagnostic: stderr })));
        }
      });
    });

    // stdin is its OWN EventEmitter: a write racing the codex process dying (EPIPE) emits 'error'
    // there, not on the child. With no listener that is an UNCAUGHT error — the whole daemon dies
    // because an MCP discovery probe lost its child. Same pattern as persistent-session.js: route
    // it into the normal failure path so only this probe fails.
    child.stdin?.on?.("error", (error) => {
      failPending(new Error(processFailureMessage("Codex MCP discovery", { spawnError: error, diagnostic: stderr })));
    });
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on?.("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    child.stdout?.on?.("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > maxMessageBytes) {
        failPending(new Error("Codex MCP discovery response exceeded the size limit"));
        try {
          child.kill?.("SIGKILL");
        } catch {}
        return;
      }
      while (buffer.includes("\n")) {
        const i = buffer.indexOf("\n");
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const waiter = pending.get(message?.id);
        if (!waiter) continue; // notifications are not part of discovery
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message || "Codex app-server error"));
        else waiter.resolve(message.result || {});
      }
    });

    const request = (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    const notify = (method, params) => child.stdin.write(`${JSON.stringify({ method, params })}\n`);

    const work = (async () => {
      await request("initialize", {
        clientInfo: { name: "channelgate", version: "1" },
        capabilities: { experimentalApi: true },
      });
      notify("initialized", {});

      const servers = [];
      let cursor = null;
      for (let page = 0; page < CODEX_MAX_PAGES; page += 1) {
        const result = await request("mcpServerStatus/list", {
          cursor,
          limit: 100,
          detail: "toolsAndAuthOnly",
        });
        if (Array.isArray(result.data)) servers.push(...result.data);
        cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
        if (!cursor) break;
      }
      return catalogFromCodexStatus(servers);
    })();

    const result = await Promise.race([work, failed]);
    settled = true;
    return result;
  } catch (error) {
    if (failClosed) return [];
    throw error;
  } finally {
    settled = true;
    clearTimeout(timer);
    failPending(new Error("Codex MCP discovery closed"));
    try {
      child?.stdin?.end?.();
      child?.kill?.("SIGTERM");
    } catch {}
  }
}

// Resolve stable persisted Codex selections against the current runtime inventory. Runtime app
// families use Codex's `apps.<family>.enabled` controls; config.toml MCP servers use their
// server-level `enabled` control.
export function codexMcpPolicyFor(catalog = [], allowed = []) {
  const selected = new Set((Array.isArray(allowed) ? allowed : []).map((entry) => `${entry?.kind || ""}:${entry?.id || ""}`));
  const apps = new Set();
  const servers = [];

  for (const entry of Array.isArray(catalog) ? catalog : []) {
    if (entry?.kind === "tool-group" && entry.serverName === "codex_apps") {
      if (selected.has(`tool-group:${entry.id}`)) {
        for (const connectorId of Array.isArray(entry.connectorIds) ? entry.connectorIds : []) {
          if (SAFE_CODEX_APP_ID.test(connectorId)) apps.add(connectorId);
        }
      }
    } else if (entry?.kind === "server" && typeof entry.serverName === "string") {
      servers.push({
        name: entry.serverName,
        enabled: selected.has(`server:${entry.id}`),
        ...(entry.definition ? { definition: entry.definition } : {}),
      });
    }
  }

  return {
    apps: [...apps].sort(),
    servers: servers.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// Re-run the engine's `mcp list` and update the cache. Dedupes concurrent refreshes.
function refresh(engine) {
  if (refreshing.has(engine)) return refreshing.get(engine);
  const p = (async () => {
    let data = cache.get(engine)?.data ?? [];
    try {
      if (engine === "codex") data = await listCodexRuntimeMcps({ failClosed: false });
      else data = parseClaude(await run("claude", ["mcp", "list"]));
    } catch {
      /* keep previous data on failure */
    }
    cache.set(engine, { ts: Date.now(), data });
    return data;
  })().finally(() => refreshing.delete(engine));
  refreshing.set(engine, p);
  return p;
}

// `claude mcp list` health-checks every server, so it's slow (~10s+). Serve the cached list
// immediately and refresh in the background when stale (stale-while-revalidate). Only the very
// first call (cold cache) waits — and the admin UI loads this off the page's critical path.
export async function listEngineMcps(engine = "claude") {
  const hit = cache.get(engine);
  if (hit) {
    if (Date.now() - hit.ts >= TTL_MS) refresh(engine); // background; don't await
    return hit.data;
  }
  return refresh(engine);
}
