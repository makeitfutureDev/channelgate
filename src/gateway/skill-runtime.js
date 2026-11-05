// Per-skill preferred model ("model-specific skills").
//
// A skill may name, in its SKILL.md frontmatter, the model it works best with:
//
//   ---
//   name: email-triage
//   model: gpt-6.1-sol        # optional; any model the gateway's engines know
//   ---
//
// Nothing else is declared — no engine (derived from the model), no "subagent or inline" choice.
// The DAEMON decides how to honor the preference at the moment the skill is actually USED, and
// its rule is: run inline whenever that is possible, imply a subagent only when inline is not.
//
// "Used" is an explicit act, never an inference from a file read: a model opens two or three
// skills to decide which applies, Codex loads a skill with a plain `cat`, and a reference skill is
// consulted without being run. So every materialized copy of a skill that declares a model carries
// one instruction line (withSkillRuntimeHeader): "before following this skill, call the gateway
// tool `use_skill`". The running turn registered a swap handler under its thread key
// (registerSkillSwapHandler); the tool reaches it through the daemon (requestSkillSwap); the turn
// applies decideSkillSwap:
//
//   - the channel switch `skillRuntimeSwap` off, no preference, or a USER pin → nothing changes;
//   - same engine, different model → INLINE: the turn ends and the SAME session is resumed with
//     the preferred model (see run.js); the model sticks on the thread as a skill preference
//     (thread override kind "skill_model") below the user's pin and above the channel default;
//   - a second skill with another model in the same turn → the model is advised to use a subagent;
//   - a different engine → the model is told to delegate through run_agent_in_background with the
//     engine/model override (a session cannot cross harnesses).
//
// The swap itself costs one prompt-cache miss (caches are model-scoped) and then caching resumes on
// the new model; sticky-per-thread is what keeps a conversation from alternating models.
import { ENGINE_IDS, modelBelongsToEngine } from "../engines/registry.js";

export const SKILL_MODEL_KEY = "model";
export const USE_SKILL_TOOL = "use_skill";
const MODEL_MAX = 64;

// The catalog's parsed frontmatter keeps every key, so `skill.meta.model` is there whenever the
// author wrote one. Empty, non-string, over-long or whitespace-bearing values are ignored, and a
// model no enabled-or-not engine recognizes is ignored too — a typo must never reach a CLI flag.
export function skillModelPreference(skill) {
  const raw = skill?.meta?.[SKILL_MODEL_KEY];
  const model = typeof raw === "string" || typeof raw === "number" ? String(raw).trim().toLowerCase() : "";
  if (!model || model.length > MODEL_MAX || /\s/.test(model)) return null;
  const engine = engineForModel(model);
  if (!engine) return null;
  return { model, engine };
}

// The first engine whose model patterns claim the id. modelBelongsToEngine() is true for an EMPTY
// value, so callers must never pass one here.
export function engineForModel(model) {
  const value = String(model || "").trim().toLowerCase();
  if (!value) return "";
  return ENGINE_IDS.find((id) => modelBelongsToEngine(value, id)) || "";
}

// ── Authoring: set or clear `model:` in a SKILL.md's frontmatter ─────────────────────────────
// Used by create_skill / update_skill's optional `model` argument so an author never has to hand-
// edit YAML. Rewrites only the one key: an existing `model:` line is replaced in place, a missing
// one is appended just before the closing `---`, an empty model removes the line, and a file with
// no frontmatter gets a minimal header. Throws on a model no engine recognizes.
export function setSkillModelFrontmatter(text, model) {
  const value = String(model ?? "").trim().toLowerCase();
  if (value && !engineForModel(value)) throw new Error(`"${value}" is not a model any engine of this gateway recognizes.`);
  const src = String(text ?? "");
  const lines = src.split(/\r?\n/);
  const line = value ? `${SKILL_MODEL_KEY}: ${value}` : "";
  if (lines[0]?.trim() !== "---") {
    if (!value) return src;
    return `---\n${line}\n---\n\n${src.replace(/^\n+/, "")}`;
  }
  const close = lines.findIndex((l, i) => i > 0 && (l.trim() === "---" || l.trim() === "..."));
  if (close === -1) throw new Error("SKILL.md frontmatter is not closed.");
  const header = lines.slice(1, close);
  const at = header.findIndex((l) => /^model\s*:/.test(l));
  if (at >= 0) {
    if (value) header[at] = line; else header.splice(at, 1);
  } else if (value) {
    header.push(line);
  }
  return [lines[0], ...header, ...lines.slice(close)].join("\n");
}

// ── The instruction line a materialized SKILL.md carries ─────────────────────────────────────

export function skillRuntimeHeader(slug) {
  return `> **ChannelGate:** before following this skill, call the gateway tool \`${USE_SKILL_TOOL}\` with \`{"name": "${slug}"}\` and do what its reply says. The reply may switch this conversation to the model this skill prefers; reading this file does not.\n\n`;
}

const SKILL_FILE = "SKILL.md";

// Returns the bundle with the header inserted into SKILL.md right after the frontmatter (or at the
// top when there is none). Byte-for-byte deterministic, so the materializer's on-disk comparison
// and its write see the same content. A skill without a preference comes back untouched (same
// object), and so does a bundle with no SKILL.md.
export function withSkillRuntimeHeader(skill, bundle) {
  const preference = skillModelPreference(skill);
  if (!preference || !bundle || !Array.isArray(bundle.files)) return bundle;
  const index = bundle.files.findIndex((file) => file?.path === SKILL_FILE);
  if (index < 0) return bundle;
  const original = bundle.files[index];
  const text = Buffer.isBuffer(original.content) ? original.content.toString("utf8") : String(original.content ?? "");
  const header = skillRuntimeHeader(skill.slug || skill.name || "");
  if (text.includes(header)) return bundle;
  const files = bundle.files.slice();
  files[index] = { ...original, content: Buffer.from(insertAfterFrontmatter(text, header), "utf8") };
  return { ...bundle, files };
}

function insertAfterFrontmatter(text, header) {
  const match = /^---[^\S\n]*\n[\s\S]*?\n---[^\S\n]*(?:\n|$)/.exec(text);
  if (!match) return header + text;
  const end = match[0].length;
  return `${text.slice(0, end)}\n${header}${text.slice(end).replace(/^\n+/, "")}`;
}

// ── The decision ─────────────────────────────────────────────────────────────────────────────
// Pure. `engine`/`model` are the turn's CURRENT runtime; `pinned` is the orchestrator's own
// user-pin verdict (a thread model/engine pin or a per-run override); `swapped` says this turn
// already switched once; `engineAvailable(id)` answers whether the other harness may run here.
export function decideSkillSwap({ meta = {}, engine = "", model = "", pinned = false, skill = null, swapped = false, engineAvailable = () => false } = {}) {
  const slug = skill?.slug || "";
  const preference = skillModelPreference(skill);
  if (!skill) return { action: "none", reason: "unknown-skill", slug };
  if (!preference) return { action: "none", reason: "no-preference", slug };
  const base = { slug, model: preference.model, engine: preference.engine };
  if (!meta?.skillRuntimeSwap) return { ...base, action: "none", reason: "disabled" };
  if (pinned) return { ...base, action: "none", reason: "pinned" };
  if (preference.engine === engine) {
    if (preference.model === String(model || "").trim().toLowerCase()) return { ...base, action: "none", reason: "already" };
    if (swapped) return { ...base, action: "subagent", reason: "second-skill" };
    return { ...base, action: "inline", reason: "same-engine" };
  }
  if (!engineAvailable(preference.engine)) return { ...base, action: "none", reason: "engine-unavailable" };
  return { ...base, action: "delegate", reason: "other-engine" };
}

// What the tool answers the model. Every branch tells it exactly what to do next.
export function skillSwapReply(decision, { engineLabel = (id) => id, currentModel = "" } = {}) {
  const name = decision?.slug || "this skill";
  switch (decision?.action) {
    case "inline":
      return `Model swap accepted: the gateway will resume THIS SAME session with ${decision.model} (${engineLabel(decision.engine)}) for the ${name} skill, and the thread stays on it. STOP NOW: end your turn immediately — no further tool calls, no further text. The resumed session continues the user's request from the transcript as it is.`;
    case "delegate":
      return `The ${name} skill prefers ${decision.model} on ${engineLabel(decision.engine)}, a different harness from this conversation's. A session cannot cross harnesses, so delegate: call run_agent_in_background with engine "${decision.engine}", model "${decision.model}" and a complete, self-contained brief for this skill's task (the agent starts with no context), then end your turn. Its report posts back into this thread.`;
    case "subagent":
      return `This turn already switched models for another skill, so ${name} is not swapped inline again. Continue on the current model${currentModel ? ` (${currentModel})` : ""}, or — if the task is a self-contained side quest — run it in a subagent using model ${decision.model}.`;
    default:
      break;
  }
  switch (decision?.reason) {
    case "unknown-skill": return `No skill named "${name}" is in this conversation's catalog. Continue with the current model.`;
    case "no-preference": return `The ${name} skill declares no preferred model. Continue with the current model.`;
    case "disabled": return `The ${name} skill prefers ${decision.model}, but skill engine/model swapping is OFF for this conversation (an admin or channel manager can enable it in the channel settings). Continue with the current model.`;
    case "pinned": return `The ${name} skill prefers ${decision.model}, but this thread's runtime was pinned by a person (/model or an explicit engine choice), and a pin is never traded away. Continue with the current model.`;
    case "already": return `Already running ${decision.model}, the model the ${name} skill prefers. Continue.`;
    case "engine-unavailable": return `The ${name} skill prefers ${decision.model} on ${engineLabel(decision.engine)}, which is not enabled for this conversation. Continue with the current model.`;
    case "no-live-turn": return "No live turn is registered for this thread, so nothing can be swapped. Continue with the current model.";
    default: return "Continue with the current model.";
  }
}

// ── Live-turn registry ───────────────────────────────────────────────────────────────────────
// run.js registers one handler per running turn under `${slug}::${threadKey}` — the very key the
// run capability carries, so a background agent (`…::agent-<id>`) and a schedule tick each find
// their OWN turn and never another's. In-memory on purpose: a swap request for a turn this daemon
// is not running (a restart in between) must answer "nothing to swap", not act on a stale row.
const handlers = new Map();

export const skillSwapKey = (slug, threadKey) => `${slug}::${threadKey}`;

export function registerSkillSwapHandler(key, handler) {
  if (!key || typeof handler !== "function") return () => {};
  handlers.set(key, handler);
  return () => { if (handlers.get(key) === handler) handlers.delete(key); };
}

export function hasSkillSwapHandler(key) { return handlers.has(key); }

// The daemon-side service behind the `use_skill` tool (DAEMON_IPC kind "skill-swap").
export async function requestSkillSwap({ slug = "", threadKey = "", name = "" } = {}) {
  const key = skillSwapKey(String(slug || ""), String(threadKey || ""));
  const handler = handlers.get(key);
  const skillName = String(name || "").trim().slice(0, 200);
  if (!handler) return { ok: true, decision: { action: "none", reason: "no-live-turn", slug: skillName } };
  try {
    const decision = await handler({ name: skillName });
    return { ok: true, decision: decision || { action: "none", reason: "no-live-turn", slug: skillName } };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

// Only used by tests to start from a clean registry.
export function _resetSkillSwapHandlers() { handlers.clear(); }
