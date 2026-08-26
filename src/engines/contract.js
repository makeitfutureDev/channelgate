import { spawn } from "node:child_process";
import { processFailureMessage } from "../util/process-outcome.js";

export const RUN_ORIGINS = Object.freeze(["slack_foreground", "api_foreground", "schedule", "background_agent", "continuation", "recovery", "diagnosis", "memory_review"]);
export const PRINCIPAL_KINDS = Object.freeze(["user", "daemon"]);

// Which principal kind each origin implies for a TRUSTED author. Explicit per-origin — the old
// `origin.endsWith("foreground")` convention would silently classify any future `*_foreground`
// origin as a live user. Audit labeling only; escalation never reads this.
export const PRINCIPAL_KIND_BY_ORIGIN = Object.freeze({
  slack_foreground: "user",
  api_foreground: "user",
  schedule: "daemon",
  background_agent: "daemon",
  continuation: "daemon",
  recovery: "daemon",
  memory_review: "daemon",
  diagnosis: "daemon",
});

export function validateRunContext(context) {
  if (!context || typeof context !== "object") throw new TypeError("RunContext is required");
  if (!context.principal || !PRINCIPAL_KINDS.includes(context.principal.kind)) {
    throw new TypeError("RunContext.principal must be a user or daemon principal");
  }
  if (!context.principal.id || typeof context.principal.id !== "string") {
    throw new TypeError("RunContext.principal.id is required");
  }
  if (!RUN_ORIGINS.includes(context.origin)) throw new TypeError(`Unsupported run origin: ${context.origin || "(missing)"}`);
  if (!context.cwd || !context.session || !context.policy) throw new TypeError("RunContext requires cwd, session, and policy");
  return Object.freeze({ ...context, principal: Object.freeze({ ...context.principal }) });
}

const REQUIRED_METHODS = ["compileConfinement", "run", "interrupt", "discoverMcps", "health"];
const REQUIRED_MANIFEST = ["id", "label", "cli", "defaultModelKey", "mcpMetaKey", "instructionFile", "skillsDir", "mcpTransport", "contextWindow"];

export function validateEngineAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") throw new TypeError("EngineAdapter must be an object");
  for (const field of REQUIRED_MANIFEST) if (!adapter[field]) throw new TypeError(`EngineAdapter missing ${field}`);
  for (const method of REQUIRED_METHODS) if (typeof adapter[method] !== "function") throw new TypeError(`EngineAdapter ${adapter.id || "?"} missing ${method}()`);
  if (!adapter.supports || !Array.isArray(adapter.efforts) || typeof adapter.modelBelongs !== "function") {
    throw new TypeError(`EngineAdapter ${adapter.id || "?"} has an incomplete capability manifest`);
  }
  const probe = adapter.compileConfinement({ allowNetwork: false, dangerouslySkip: false, writable: false });
  if (!probe || probe.supported !== true || probe.network?.mode !== "off") {
    throw new TypeError(`EngineAdapter ${adapter.id} confinement compiler must fail closed to network-off`);
  }
  return Object.freeze(adapter);
}

export function createAdapterRegistry(adapters) {
  const map = new Map();
  for (const raw of adapters || []) {
    const adapter = validateEngineAdapter(raw);
    if (map.has(adapter.id)) throw new TypeError(`Duplicate EngineAdapter id: ${adapter.id}`);
    map.set(adapter.id, adapter);
  }
  return Object.freeze({
    ids: Object.freeze([...map.keys()]),
    get: (id) => map.get(String(id || "")) || null,
    require(id) {
      const adapter = map.get(String(id || ""));
      if (!adapter) throw new Error(`Unknown or unavailable engine: ${id || "(missing)"}`);
      return adapter;
    },
    manifests: () => [...map.values()].map(({ run, interrupt, discoverMcps, health, credentialState, compileConfinement, modelBelongs, resumeCommand, ...manifest }) => structuredClone(manifest)),
  });
}

// 10s, not 3s: the engine CLIs are ~250MB binaries whose cold start on a loaded machine blows a
// 3s window — and a timed-out probe logs "CLI not available", which reads as an outage exactly
// when someone is debugging one.
// A Slack message that IS a single flag-shaped token (e.g. `--file=/etc/passwd`) must never be
// parsed by an engine CLI as an option: the prompt rides argv in every runner, and harness-level
// flags like --file are read OUTSIDE the model-tool permission gate. A leading space defuses
// option detection in clap/cobra/commander alike without shell involvement (argv elements are
// never re-tokenized) and is invisible to the model.
export function argvSafePrompt(prompt) {
  const text = String(prompt ?? "").trim();
  return text.startsWith("-") ? ` ${text}` : text;
}

export function commandHealth(cli, { spawnImpl = spawn, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const child = spawnImpl(cli, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    const finish = (ready, error = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ready, cli, version: output.trim(), error });
    };
    const timer = setTimeout(() => { child.kill?.("SIGKILL"); finish(false, "version check timed out"); }, timeoutMs);
    timer.unref?.();
    child.stdout?.on?.("data", (chunk) => { output += chunk; });
    child.stderr?.on?.("data", (chunk) => { output += chunk; });
    child.on?.("error", (error) => finish(false, processFailureMessage(cli, { spawnError: error, diagnostic: output })));
    child.on?.("close", (code, signal) => finish(
      code === 0 && !signal,
      code === 0 && !signal ? "" : processFailureMessage(cli, { code, signal, diagnostic: output }),
    ));
  });
}
