// Real engine smoke test for transactional self-updates. The probe intentionally bypasses the
// normal channel/session stack but NOT the gateway's confinement contract: Claude runs cold in a
// temporary gateway-owned folder, with project/user MCPs replaced by an empty strict config,
// memory disabled, bypass/auto modes disabled, and filesystem/network access confined.
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gatewayRoot } from "../config/paths.js";
import { runClaude } from "../engines/claude.js";

const RESPONSE = "CG_UPDATE_SMOKE_OK";
const PROMPT =
  `This is an automated gateway update health probe. Do not use tools. ` +
  `Reply with exactly ${RESPONSE}.`;

function sandboxPath(absolutePath) {
  return `/${String(absolutePath).replace(/^\/+/, "")}`;
}

function smokeSettings({ folder, root }) {
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
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: [sandboxPath(os.homedir()), sandboxPath(root)],
        allowRead: [sandboxPath(folder)],
        denyWrite: [sandboxPath(os.homedir()), sandboxPath(root)],
        allowWrite: [sandboxPath(folder)],
      },
    },
  };
}

export async function prepareUpdateSmokeFolder({
  root = gatewayRoot(),
  id = randomUUID(),
} = {}) {
  const safeId = String(id).replace(/[^a-zA-Z0-9-]/g, "") || randomUUID();
  const smokeRoot = path.join(root, "update-smoke");
  const folder = path.join(smokeRoot, safeId);
  const settingsFile = path.join(folder, ".claude", "settings.json");
  const mcpFile = path.join(folder, ".claude", "mcp.json");
  const settings = smokeSettings({ folder, root });

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

export async function runUpdateSmoke({
  root = gatewayRoot(),
  runner = runClaude,
  timeoutMs = 60_000,
  totalTimeoutMs = 90_000,
} = {}) {
  const probe = await prepareUpdateSmokeFolder({ root });
  const controller = new AbortController();
  const totalTimer = setTimeout(() => controller.abort(), totalTimeoutMs);
  totalTimer.unref?.();
  const startedAt = Date.now();
  try {
    const result = await runner({
      cwd: probe.folder,
      prompt: PROMPT,
      sessionId: randomUUID(),
      isNewSession: true,
      mcpConfig: probe.mcpFile,
      strictMcp: true,
      dangerouslySkip: false,
      settingsFile: probe.settingsFile,
      model: "",
      effort: "",
      permissionPromptTool: "",
      timeoutMs,
      signal: controller.signal,
    });
    const durationMs = Number(result?.durationMs) || Date.now() - startedAt;
    if (!validSmokeResponse(result?.content)) {
      return { ok: false, durationMs, error: "Claude smoke probe returned an unexpected response." };
    }
    return { ok: true, durationMs };
  } catch (error) {
    return { ok: false, durationMs: Date.now() - startedAt, error: safeError(error) };
  } finally {
    clearTimeout(totalTimer);
    await probe.cleanup();
  }
}
