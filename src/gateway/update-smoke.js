import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gatewayRoot } from "../config/paths.js";
import { ENGINE_IDS, requireAdapter } from "../engines/registry.js";
import { resolveRuntime } from "../runtimes/resolve.js";
import { getContainerRuntime } from "../config/settings.js";

const RESPONSE = "CG_UPDATE_SMOKE_OK";
const PROMPT =
  `This is an automated gateway update health probe. Do not use tools. ` +
  `Reply with exactly ${RESPONSE}.`;

function smokeSettings() {
  const denyTools = [
    "Bash",
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
    "mcp__claude-in-chrome",
    "mcp__computer-use",
  ];
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    allowedMcpServers: [],
    autoMemoryEnabled: false,
    autoDreamEnabled: false,
    enableAllProjectMcpServers: false,
    enabledMcpjsonServers: [],
    permissions: {
      defaultMode: "default",
      disableBypassPermissionsMode: "disable",
      disableAutoMode: "disable",
      additionalDirectories: [],
      allow: [],
      deny: denyTools,
    },
  };
}

export async function prepareUpdateSmokeFolder({
  root = gatewayRoot(),
  id = randomUUID(),
  folder: requestedFolder,
} = {}) {
  const safeId = String(id).replace(/[^a-zA-Z0-9-]/g, "") || randomUUID();
  const smokeRoot = path.join(root, "update-smoke");
  const folder = requestedFolder || path.join(smokeRoot, safeId);
  const settingsFile = path.join(folder, ".claude", "settings.json");
  const mcpFile = path.join(folder, ".claude", "mcp.json");
  const settings = smokeSettings();

  await mkdir(path.dirname(settingsFile), { recursive: true, mode: 0o700 });
  await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await writeFile(mcpFile, `${JSON.stringify({ mcpServers: {} })}\n`, { mode: 0o600 });

  let cleaned = false;
  return {
    folder,
    settingsFile,
    mcpFile,
    settings,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(folder, { recursive: true, force: true });
    },
  };
}

export function validSmokeResponse(content) {
  return String(content ?? "").trim() === RESPONSE;
}

function safeError(error) {
  const firstLine = String(error?.message || "Claude smoke probe failed").split(/\r?\n/, 1)[0].trim();
  return firstLine.slice(0, 240) || "Claude smoke probe failed";
}

// A dedicated ephemeral channel target uses the same confinement and credentials as real turns.
// The caller may inject the runtime and adapters in tests; production has no host fallback.
export async function runUpdateSmoke({
  root = gatewayRoot(),
  engines = ENGINE_IDS.map(requireAdapter).filter((entry) => entry.updateSmoke),
  resolveTarget = (slug) => resolveRuntime(slug, { adminMode: false, allowNetwork: true }, {
    settings: { ...getContainerRuntime(), fullAccessHome: false },
  }),
  requiredEngines = [],
  timeoutMs = 60_000,
} = {}) {
  const startedAt = Date.now();
  const results = [];
  let target, probe, release, owned = false;
  try {
    target = resolveTarget(`update-smoke-${randomUUID()}`);
    if (target?.backend !== "container" || !target.runtime?.capabilities?.isolated) {
      throw new Error("Update smoke requires an isolated container target");
    }
    owned = true;
    probe = await prepareUpdateSmokeFolder({ root, folder: target.cwd });
    release = target.runtime.acquireLease(target, { kind: "update-smoke" });
    await target.runtime.ensureUp(target, { forceImage: true });
    for (const engine of engines) {
      const credentialFailure = await target.runtime.credentialError(target, engine.id);
      if (credentialFailure) {
        if (target.container?.credentialMode?.[engine.id] === "missing" && !requiredEngines.includes(engine.id)) {
          results.push({ engine: engine.id, skipped: true, reason: "No configured login" });
        } else {
          results.push({ engine: engine.id, ok: false, error: safeError(credentialFailure) });
        }
        continue;
      }
      const engineStart = Date.now();
      try {
        const result = await engine.updateSmoke({
          target, cwd: probe.folder, prompt: PROMPT, sessionId: randomUUID(), isNewSession: true,
          mcpConfig: probe.mcpFile, strictMcp: true, dangerouslySkip: false,
          settingsFile: probe.settingsFile, model: "", effort: "", permissionPromptTool: "",
          timeoutMs,
        });
        const ok = validSmokeResponse(result?.content);
        results.push({ engine: engine.id, ok, durationMs: Date.now() - engineStart,
          ...(!ok ? { error: "Engine smoke probe returned an unexpected response." } : {}) });
      } catch (error) {
        results.push({ engine: engine.id, ok: false, durationMs: Date.now() - engineStart, error: safeError(error) });
      }
    }
  } catch (error) {
    results.push({ ok: false, error: safeError(error) });
  } finally {
    const cleanup = async (fn) => {
      try { await fn(); } catch (error) { results.push({ ok: false, error: `Smoke cleanup failed: ${safeError(error)}` }); }
    };
    if (owned) {
      await cleanup(() => target.runtime.destroy(target, { volumes: true, strictVolumes: true, reason: "update smoke finished" }));
      if (probe) await cleanup(() => probe.cleanup());
      for (const dir of [target.cleanWorkDir, target.artifactDir]) if (dir) await cleanup(() => rm(dir, { recursive: true, force: true }));
    }
    if (typeof release === "function") release();
  }
  for (const id of requiredEngines) {
    if (!results.some((entry) => entry.engine === id && entry.ok)) {
      results.push({ engine: id, ok: false, error: "Engine that passed before the update did not pass verification." });
    }
  }
  const tested = results.filter((entry) => !entry.skipped);
  const failed = tested.find((entry) => !entry.ok);
  return { ok: tested.length > 0 && !failed, durationMs: Date.now() - startedAt, engines: results,
    ...(failed ? { error: `${failed.engine ? `${failed.engine}: ` : ""}${failed.error}` }
      : !tested.length ? { error: "No configured engine login is available for update verification." } : {}) };
}
