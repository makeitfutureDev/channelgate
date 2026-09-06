import { execFile } from "node:child_process";

const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const EFFORT_RE = /^[a-z][a-z0-9_-]{0,31}$/i;

const clipped = (value, max) => String(value ?? "").trim().slice(0, max);

// Codex owns the selectable model catalog for the authenticated installation. Keep this probe
// argv-only (no shell), bounded in time and bytes, and reduce its large response to the small UI
// facts ChannelGate needs. Hidden migrations and retired models must never become picker buttons.
export function discoverCodexModels({
  execFileImpl = execFile,
  env = process.env,
  timeoutMs = 10_000,
  maxBuffer = 10 * 1024 * 1024,
} = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl("codex", ["debug", "models"], {
      env,
      timeout: timeoutMs,
      maxBuffer,
      encoding: "utf8",
      windowsHide: true,
    }, (error, stdout = "", stderr = "") => {
      if (error) {
        const diagnostic = clipped(stderr || error.message, 300);
        reject(new Error(`Codex model discovery failed${diagnostic ? `: ${diagnostic}` : ""}`));
        return;
      }
      let payload;
      try {
        payload = JSON.parse(String(stdout));
      } catch {
        reject(new Error("Codex model discovery returned malformed JSON"));
        return;
      }
      const models = (Array.isArray(payload?.models) ? payload.models : [])
        .filter((model) => model?.visibility === "list" && MODEL_ID_RE.test(String(model.slug || "")))
        .map((model) => ({
          value: clipped(model.slug, 128),
          label: clipped(model.display_name || model.slug, 80),
          description: clipped(model.description, 240),
          efforts: [...new Set((Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [])
            .map((level) => clipped(level?.effort, 32).toLowerCase())
            .filter((effort) => EFFORT_RE.test(effort)))],
          defaultEffort: clipped(model.default_reasoning_level, 32).toLowerCase(),
        }));
      if (!models.length) {
        reject(new Error("Codex model discovery returned no selectable models"));
        return;
      }
      resolve(models);
    });
  });
}
