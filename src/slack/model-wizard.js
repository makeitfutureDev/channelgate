// The /model wizard (extracted from slack/app.js — the 2026-08 restructure notes (internal repo) Phase 2.3).
// ONE command for the whole runtime (the old /engine and /effort are folded in): /model walks
// through four steps in a single message that updates in place —
//   1. scope   — "This channel" or "Just this thread" (buttons)
//   2. harness — Claude / Codex (buttons; "Use defaults" clears the scope's overrides and ends)
//   3. model   — buttons, one per model, filtered to the chosen harness
//   4. effort  — buttons, one per effort level, filtered to the chosen harness
// Every step is a flat list of buttons — no dropdowns anywhere in the flow. Each step persists the
// moment it's clicked, so abandoning mid-wizard keeps the steps already
// taken. Steps 2-4 also carry a "← Back" button (and the done card a "Change again"), which walks
// the same message to an earlier step so a mis-click is corrected by re-picking rather than by
// re-running /model. Channel scope writes meta.engine/model/effort (what the old pickers did); thread scope
// writes the per-thread overrides (thread-engine.js), which beat the channel at run time. Wizard
// state ({s: scope, t: threadTs}) rides inside every button/option value as compact JSON, because
// the registered-slash-command variant is an ephemeral message with no body.message to read a
// thread from on the next click.
import { getChannelEntry, getChannelMeta, patchChannelMeta, isAdmin, isApproved } from "../config/store.js";
// A channel-scope runtime pick (engine / model / effort) is a policy change — audited like the
// admin UI's save and the `/mode` command (config/channel-audit.js). Thread-scope picks are not:
// they live in the thread override store, never in the channel's meta.
import { logChannelPolicyChange } from "../config/channel-audit.js";
import { getEngine, canChangeChannelRuntime, getEnabledEngines } from "../config/settings.js";
import { effectiveMeta } from "../gateway/run.js";
import { isAuthorized } from "../gateway/modes.js";
import { setThreadEngine, getThreadEngine, setThreadModel, getThreadModel, setThreadEffort, getThreadEffort } from "../gateway/thread-engine.js";
import { ENGINE_IDS, adapterFor, requireAdapter, modelBelongsToEngine, effortBelongsToEngine, effortBelongsToModel, effortsForModel, modelsForEngine, refreshEngineModels } from "../engines/registry.js";
import { isValidModel } from "./util.js";

// ONE command for the whole runtime (the old /engine and /effort are folded in): /model walks
// through four steps in a single message that updates in place —
//   1. scope   — "This channel" or "Just this thread" (buttons)
//   2. harness — Claude / Codex (buttons; "Use defaults" clears the scope's overrides and ends)
//   3. model   — buttons, one per model, filtered to the chosen harness
//   4. effort  — buttons, one per effort level, filtered to the chosen harness
// Every step is a flat list of buttons — no dropdowns anywhere in the flow. Each step persists the
// moment it's clicked, so abandoning mid-wizard keeps the steps already
// taken. Channel scope writes meta.engine/model/effort (what the old pickers did); thread scope
// writes the per-thread overrides (thread-engine.js), which beat the channel at run time. Wizard
// state ({s: scope, t: threadTs}) rides inside every button/option value as compact JSON, because
// the registered-slash-command variant is an ephemeral message with no body.message to read a
// thread from on the next click.
export const MODEL_WIZARD_SCOPE_CHANNEL_ACTION = "cg_mw_scope_channel";
export const MODEL_WIZARD_SCOPE_THREAD_ACTION = "cg_mw_scope_thread";
export const MODEL_WIZARD_ENGINE_CLAUDE_ACTION = "cg_mw_engine_claude";
export const MODEL_WIZARD_ENGINE_CODEX_ACTION = "cg_mw_engine_codex";
export const MODEL_WIZARD_ENGINE_RESET_ACTION = "cg_mw_engine_reset";
// Every step after the first carries a "← Back" button, and the final card a "Change again" — a
// step persists the moment it is clicked, so someone who hits the wrong scope/harness/model needs
// the way back to that step without re-running `/model`. Back is pure NAVIGATION: it repaints the
// earlier step (never undoes the write), and the pick made there overwrites what the mistaken
// click stored. Named per DESTINATION step, so the handler reads the target off the action_id.
export const MODEL_WIZARD_BACK_SCOPE_ACTION = "cg_mw_back_scope"; // → step 1 (scope)
export const MODEL_WIZARD_BACK_ENGINE_ACTION = "cg_mw_back_engine"; // → step 2 (harness)
export const MODEL_WIZARD_BACK_MODEL_ACTION = "cg_mw_back_model"; // → step 3 (model)
export const MODEL_WIZARD_BACK_ACTION_PATTERN = /^cg_mw_back_(?:scope|engine|model)$/;
// The model/effort steps render one button per choice, and Slack requires a UNIQUE action_id inside
// a block — so each button gets an index suffix (`cg_model_pick_2`) and both the Bolt registration
// and the handler match on the base prefix. The bare id is still accepted: it's what the retired
// static_select carried, and those messages are still clickable in Slack history.
export const MODEL_PICKER_ACTION = "cg_model_pick";
export const EFFORT_PICKER_ACTION = "cg_effort_pick";
export const MODEL_PICKER_ACTION_PATTERN = /^cg_model_pick(?:_\d+)?$/;
export const EFFORT_PICKER_ACTION_PATTERN = /^cg_effort_pick(?:_\d+)?$/;
export const ENGINE_PICKER_ACTION = "cg_engine_pick"; // legacy /engine dropdowns still sitting in Slack history
const isPickerAction = (actionId, base) => actionId === base || actionId.startsWith(`${base}_`);
const DEFAULT_PICKER_VALUE = "__default__";

function encodeWizardState({ scope, threadTs, value }) {
  return JSON.stringify({ s: scope === "thread" ? "t" : "c", t: threadTs || "", ...(value === undefined ? {} : { v: value }) });
}

// Picker messages posted BEFORE the wizard shipped carry the bare option value — decode those as
// a channel-scope pick (their original semantics) so a stale dropdown still works after an update.
function decodeWizardState(raw) {
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === "object") return { scope: o.s === "t" ? "thread" : "channel", threadTs: o.t || "", value: o.v };
  } catch {
    /* legacy plain value */
  }
  return { scope: "channel", threadTs: "", value: raw };
}

const MODEL_DEFAULT_OPTION = { label: "Gateway default", value: DEFAULT_PICKER_VALUE, description: "Use the gateway's default model (admin UI Settings)." };
const EFFORT_DEFAULT_OPTION = { label: "Engine default", value: DEFAULT_PICKER_VALUE, description: "Use the engine's default reasoning effort." };


// Effort options are BUILT from the shared per-engine value lists (slack/util.js), so the picker
// can never drift from what effortBelongsToEngine accepts.
const EFFORT_LABELS = { none: "None", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max", ultra: "Ultra" };
const EFFORT_DESCRIPTIONS = {
  none: "No extra reasoning effort.",
  low: "Faster, lower reasoning budget.",
  medium: "Balanced reasoning budget.",
  high: "Deeper reasoning for harder work.",
  xhigh: "Very high reasoning effort.",
  max: "Maximum reasoning effort.",
  ultra: "Maximum reasoning with automatic task delegation.",
};
const effortOption = (v) => ({ label: EFFORT_LABELS[v] || v, value: v, description: EFFORT_DESCRIPTIONS[v] });
function runtimeEngine(meta = {}) {
  const id = String(meta.engine || getEngine() || "").toLowerCase();
  return adapterFor(id) ? id : ENGINE_IDS[0];
}

export function modelOptionsForEngine(engine) {
  return [MODEL_DEFAULT_OPTION, ...modelsForEngine(engine)];
}

function effortOptionsForEngine(engine, model = "") {
  return [EFFORT_DEFAULT_OPTION, ...effortsForModel(engine, model).map(effortOption)];
}

function decodePickerValue(value) {
  return value === DEFAULT_PICKER_VALUE ? "" : String(value || "").trim();
}

// Where a wizard choice lands, in words — used in every step's header and the done message.
function wizardScopeLabel(scope, isDM) {
  return scope === "thread" ? "just this thread" : isDM ? "this DM" : "this whole channel";
}

// Only harnesses the admin left enabled are offered — the wizard must not hand someone a button
// that writes an override the orchestrator will immediately substitute away. Falls back to the full
// list if the setting somehow disables everything (the getter already fails open).
const OFFERED_ENGINE_IDS = () => {
  const enabled = getEnabledEngines().filter((id) => adapterFor(id));
  return enabled.length ? enabled : ENGINE_IDS;
};
const ENGINE_LABELS = () => OFFERED_ENGINE_IDS().map((id) => requireAdapter(id).label).join(" / ");
export const MODEL_WIZARD_TEXT = `Change the model: pick scope, then harness (${ENGINE_LABELS()}), then model, then effort.`;

export const RETIRED_COMMAND_TEXT = (cmd) => `\`${cmd}\` was removed — \`/model\` now does it all: scope (channel or just this thread) → harness (${ENGINE_LABELS()}) → model → effort.`;

function wizardButton(actionId, label, value) {
  return { type: "button", action_id: actionId, text: { type: "plain_text", text: label, emoji: false }, value };
}

// A back/restart button carries the same wizard state as the step it sits on (scope + thread), so
// the repaint knows which scope it is walking back into. No `value` of its own — the destination
// step is the action_id.
function backButton(actionId, { scope, threadTs, label = "← Back" }) {
  return wizardButton(actionId, label, encodeWizardState({ scope, threadTs }));
}

// Slack rejects an actions block with more than 25 elements, so a long model list is split across
// consecutive blocks rather than silently truncated.
const MAX_ACTION_ELEMENTS = 25;
function actionRows(elements) {
  const rows = [];
  for (let i = 0; i < elements.length; i += MAX_ACTION_ELEMENTS) rows.push({ type: "actions", elements: elements.slice(i, i + MAX_ACTION_ELEMENTS) });
  return rows;
}

export function modelWizardScopeBlocks({ threadTs, meta }) {
  const button = (actionId, label) => wizardButton(actionId, label, encodeWizardState({ scope: actionId === MODEL_WIZARD_SCOPE_THREAD_ACTION ? "thread" : "channel", threadTs }));
  const elements = [button(MODEL_WIZARD_SCOPE_CHANNEL_ACTION, meta.isDM ? "This DM" : "This channel")];
  if (threadTs) elements.push(button(MODEL_WIZARD_SCOPE_THREAD_ACTION, "Just this thread"));
  return [
    { type: "section", text: { type: "mrkdwn", text: "*Change the model* — where should it apply?" } },
    { type: "actions", elements },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Step 1 of 4 — scope, then harness (${ENGINE_LABELS()}), model, effort.` + (threadTs ? "" : " To change a single thread, run `/model` inside that thread."),
        },
      ],
    },
  ];
}

function modelWizardEngineBlocks({ scope, threadTs, meta, threadEngine = "" }) {
  const button = (actionId, label) => wizardButton(actionId, label, encodeWizardState({ scope, threadTs }));
  const current = scope === "thread" ? threadEngine || "channel default" : meta.engine || "gateway default";
  return [
    { type: "section", text: { type: "mrkdwn", text: `*Which harness?* — for ${wizardScopeLabel(scope, meta.isDM)}\nCurrent: \`${current}\`` } },
    {
      type: "actions",
      elements: [
        ...OFFERED_ENGINE_IDS().map((id) => button(`cg_mw_engine_${id}`, requireAdapter(id).label)),
        button(MODEL_WIZARD_ENGINE_RESET_ACTION, "Use defaults"),
        backButton(MODEL_WIZARD_BACK_SCOPE_ACTION, { scope, threadTs }),
      ],
    },
    { type: "context", elements: [{ type: "mrkdwn", text: "Step 2 of 4 — model and effort next. *Use defaults* instead clears the harness/model/effort overrides for this scope. *← Back* returns to the scope step." }] },
  ];
}

// Shared shape for the model + effort steps: a header section, then ONE BUTTON PER CHOICE (these
// were static_selects until 2026-08-18 — the whole wizard is buttons now, so a choice is one click
// instead of open-menu-then-pick). Each button embeds the wizard state in its value; `current` is
// the choice already in force, marked with a ✓ and the primary style since a button list has no
// equivalent of a select's initial_option.
function wizardChoiceBlocks({ scope, threadTs, actionId, options, current, header, step, backActionId }) {
  const selected = current || DEFAULT_PICKER_VALUE;
  const elements = options.map((o, i) => {
    const button = wizardButton(`${actionId}_${i}`, o.value === selected ? `✓ ${o.label}` : o.label, encodeWizardState({ scope, threadTs, value: o.value }));
    return o.value === selected ? { ...button, style: "primary" } : button;
  });
  return [
    { type: "section", text: { type: "mrkdwn", text: header } },
    ...actionRows(elements),
    // Back rides in its OWN actions block: the choice rows are already packed to Slack's 25-element
    // limit, and a step with exactly 25 choices would otherwise push it onto a row of its own anyway.
    ...(backActionId ? [{ type: "actions", elements: [backButton(backActionId, { scope, threadTs })] }] : []),
    { type: "context", elements: [{ type: "mrkdwn", text: step }] },
  ];
}

export function modelWizardModelBlocks({ scope, threadTs, engine, current, isDM }) {
  return wizardChoiceBlocks({
    scope,
    threadTs,
    actionId: MODEL_PICKER_ACTION,
    options: modelOptionsForEngine(engine),
    current,
    backActionId: MODEL_WIZARD_BACK_ENGINE_ACTION,
    header: `*Choose a ${requireAdapter(engine).label} model* — for ${wizardScopeLabel(scope, isDM)}\nCurrent: \`${current || "default"}\``,
    step: "Step 3 of 4 — effort next. *Gateway default* clears the model override. *← Back* returns to the harness step.",
  });
}

export function modelWizardEffortBlocks({ scope, threadTs, engine, model, current, isDM }) {
  return wizardChoiceBlocks({
    scope,
    threadTs,
    actionId: EFFORT_PICKER_ACTION,
    options: effortOptionsForEngine(engine, model),
    current,
    backActionId: MODEL_WIZARD_BACK_MODEL_ACTION,
    header: `*Choose reasoning effort* — for ${wizardScopeLabel(scope, isDM)}\nModel: \`${model || "default"}\` · Current effort: \`${current || "default"}\``,
    step: "Step 4 of 4 — done after this. *Engine default* clears the override. *← Back* returns to the model step.",
  });
}

function modelWizardDoneBlocks({ scope, threadTs, isDM, engine, model, effort, reset = false }) {
  const where = wizardScopeLabel(scope, isDM);
  const text = reset
    ? `✅ Cleared — ${where} now follows the ${scope === "thread" ? "channel's" : "gateway's"} default harness, model, and effort.`
    : `✅ Runtime updated for ${where}\nHarness: *${requireAdapter(engine).label}* · Model: \`${model || "default"}\` · Effort: \`${effort || "default"}\``;
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    // The last click ends the wizard, so a wrong final pick would otherwise cost a fresh `/model`.
    // This walks the SAME message back to step 1 instead.
    { type: "actions", elements: [backButton(MODEL_WIZARD_BACK_SCOPE_ACTION, { scope, threadTs, label: "Change again" })] },
  ];
}

export async function postModelWizard(client, { channel, threadTs, meta }) {
  await client.chat.postMessage({
    channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text: MODEL_WIZARD_TEXT,
    blocks: modelWizardScopeBlocks({ threadTs, meta }),
  });
}

async function updateRuntimePickerMessage({ client, respond, channel, ts, text, blocks }) {
  if (channel && ts) {
    try {
      await client.chat.update({ channel, ts, text, blocks });
      return;
    } catch (e) {
      console.warn(`[slack] runtime picker chat.update failed: ${e.message}`);
    }
  }
  if (respond) {
    await respond({ replace_original: true, text, blocks });
  }
}

// One handler for every /model wizard step. Which step fired is read off the action_id; the
// scope + thread ride in the clicked element's value (see encodeWizardState). Every step
// persists immediately and repaints the same message with the next step.
export async function handleModelWizard({ ack, body, action, client, respond }) {
  await ack();
  const userId = body?.user?.id;
  const channel = body?.channel?.id || body?.container?.channel_id;
  // An ephemeral wizard (the registered slash command) can't be chat.update-d — leave ts empty so
  // the repaint goes straight to respond(replace_original) instead of a doomed update + warn.
  const ts = body?.container?.is_ephemeral ? "" : body?.container?.message_ts || body?.message?.ts;
  const actionId = action?.action_id || "";
  const raw = action?.selected_option?.value ?? action?.value;
  const state = decodeWizardState(raw);
  // Prefer the encoded thread (the ephemeral slash-command variant has no body.message); fall
  // back to the clicked message's own thread for picker messages posted before the wizard shipped.
  const threadTs = state.threadTs || body?.message?.thread_ts || "";
  const scope = state.scope === "thread" ? "thread" : "channel";
  if (!userId || !channel) return;
  const ephemeral = (text) => client.chat.postEphemeral({ channel, user: userId, ...(threadTs ? { thread_ts: threadTs } : {}), text }).catch(() => {});
  // A thread-scoped pick must never silently widen to the whole channel because the thread id got
  // lost — refuse instead of downgrading.
  if (scope === "thread" && !threadTs) {
    await ephemeral("I can't tell which thread this pick was for — run `/model` again inside the thread you want to change.");
    return;
  }

  try {
    const entry = await getChannelEntry(channel);
    const meta = entry ? await getChannelMeta(entry.slug) : null;
    if (!entry || !meta) {
      await ephemeral("This channel isn't registered with the gateway yet.");
      return;
    }

    const isDM = Boolean(meta.isDM);
    const userIsAdmin = await isAdmin(userId);
    const userIsApproved = await isApproved(userId);
    if (!isAuthorized(meta, userId, isDM, { isAdminUser: userIsAdmin, isApprovedUser: userIsApproved })) {
      await ephemeral("You're not approved to change runtime settings here.");
      return;
    }
    if (!isDM && !canChangeChannelRuntime(userIsAdmin)) {
      await ephemeral("Only admins can change the harness, model, or effort in a channel.");
      return;
    }

    const repaint = (blocks) => updateRuntimePickerMessage({ client, respond, channel, ts, text: MODEL_WIZARD_TEXT, blocks });
    // Persist a channel-scope pick AND record who changed what. The replaced record is captured
    // inside the store transaction, so the diff is against what this click really overwrote.
    const patchChannelRuntime = async (patch) => {
      let replaced = null;
      const next = await patchChannelMeta(entry.slug, (current) => {
        replaced = current;
        return patch;
      });
      await logChannelPolicyChange({ channelId: channel, slug: entry.slug, actor: userId, before: replaced, after: next, source: "slack-runtime-picker" });
      return next;
    };
    const clearThreadOverrides = async () => {
      await setThreadEngine(entry.slug, threadTs, "");
      await setThreadModel(entry.slug, threadTs, "");
      await setThreadEffort(entry.slug, threadTs, "");
    };

    // "← Back" / "Change again": repaint an EARLIER step in this same message. Nothing is written
    // or unwritten here — each step already persisted when it was clicked, and re-picking there
    // overwrites it. Every step is re-read from the store so the repainted card shows what is
    // actually in force right now (including the pick being corrected).
    if (actionId === MODEL_WIZARD_BACK_SCOPE_ACTION) {
      await repaint(modelWizardScopeBlocks({ threadTs, meta }));
      return;
    }
    if (actionId === MODEL_WIZARD_BACK_ENGINE_ACTION) {
      const threadEngine = scope === "thread" ? await getThreadEngine(entry.slug, threadTs) : "";
      await repaint(modelWizardEngineBlocks({ scope, threadTs, meta: effectiveMeta(meta), threadEngine }));
      return;
    }
    if (actionId === MODEL_WIZARD_BACK_MODEL_ACTION) {
      const backEngine = (scope === "thread" ? await getThreadEngine(entry.slug, threadTs) : "") || runtimeEngine(effectiveMeta(meta));
      const backModel = (scope === "thread" ? await getThreadModel(entry.slug, threadTs) : meta.model) || "";
      await repaint(modelWizardModelBlocks({ scope, threadTs, engine: backEngine, current: backModel, isDM }));
      return;
    }

    // Step 1 → 2: scope picked. (A thread pick with no resolvable thread was already refused above.)
    if (actionId === MODEL_WIZARD_SCOPE_CHANNEL_ACTION || actionId === MODEL_WIZARD_SCOPE_THREAD_ACTION) {
      const chosen = actionId === MODEL_WIZARD_SCOPE_THREAD_ACTION ? "thread" : "channel";
      const threadEngine = chosen === "thread" ? await getThreadEngine(entry.slug, threadTs) : "";
      await repaint(modelWizardEngineBlocks({ scope: chosen, threadTs, meta: effectiveMeta(meta), threadEngine }));
      return;
    }

    // Step 2 shortcut: "Use defaults" clears every override for the scope and ends the wizard.
    if (actionId === MODEL_WIZARD_ENGINE_RESET_ACTION) {
      if (scope === "thread") {
        await clearThreadOverrides();
      } else {
        await patchChannelRuntime({ engine: "", model: "", effort: "" });
        // A channel-wide reset asked for from inside a thread also drops that thread's own
        // overrides, so the reset visibly applies right where it was requested.
        if (threadTs) await clearThreadOverrides();
      }
      await updateRuntimePickerMessage({ client, respond, channel, ts, text: "Runtime overrides cleared.", blocks: modelWizardDoneBlocks({ scope, threadTs, isDM, reset: true }) });
      return;
    }

    // Step 2 → 3: harness picked. Persist it, clearing any stored model/effort that doesn't
    // belong to the new engine (they flow straight into --model / effort flags, so a leftover
    // from the other harness would break every turn).
    if (actionId.startsWith("cg_mw_engine_") && actionId !== MODEL_WIZARD_ENGINE_RESET_ACTION) {
      const engine = actionId.slice("cg_mw_engine_".length);
      if (!adapterFor(engine)) throw new Error(`Unknown engine choice: ${engine}`);
      let current = "";
      if (scope === "thread") {
        await setThreadEngine(entry.slug, threadTs, engine);
        const tm = await getThreadModel(entry.slug, threadTs);
        if (modelBelongsToEngine(tm, engine)) current = tm;
        else await setThreadModel(entry.slug, threadTs, "");
        if (!effortBelongsToEngine(await getThreadEffort(entry.slug, threadTs), engine)) await setThreadEffort(entry.slug, threadTs, "");
      } else {
        const patch = { engine };
        if (!modelBelongsToEngine(meta.model, engine)) patch.model = "";
        if (!effortBelongsToEngine(meta.effort, engine)) patch.effort = "";
        const next = await patchChannelRuntime(patch);
        current = next.model || "";
        // The channel choice should govern this thread too — drop any thread-level overrides here
        // (engine set by a "claude"/"codex" prefix, model/effort by an earlier thread-scoped run).
        if (threadTs) await clearThreadOverrides();
      }
      // The authenticated CLI is the source of truth for selectable Codex models. Refresh only
      // when its bounded cache is stale; failure keeps the last known-good/static catalog.
      await refreshEngineModels(engine);
      await repaint(modelWizardModelBlocks({ scope, threadTs, engine, current, isDM }));
      return;
    }

    // Steps 3 + 4 read the harness back from what step 2 persisted (also correct for the legacy
    // pre-wizard dropdowns, which were always channel-scope on the channel's engine).
    // effectiveMeta: a template-managed DM takes its engine from the org template, as run.js will.
    const engine = (scope === "thread" ? await getThreadEngine(entry.slug, threadTs) : "") || runtimeEngine(effectiveMeta(meta));
    const val = decodePickerValue(state.value);

    // Step 3 → 4: model picked.
    if (isPickerAction(actionId, MODEL_PICKER_ACTION)) {
      if (!modelOptionsForEngine(engine).some((o) => o.value === (val || DEFAULT_PICKER_VALUE))) {
        await ephemeral("That model does not belong to the chosen harness.");
        return;
      }
      if (val && !isValidModel(val)) {
        await ephemeral("That model is not allowed by the gateway validation rules.");
        return;
      }
      let effortCurrent = "";
      if (scope === "thread") {
        await setThreadModel(entry.slug, threadTs, val);
        effortCurrent = await getThreadEffort(entry.slug, threadTs);
        if (!effortBelongsToModel(effortCurrent, engine, val)) {
          effortCurrent = "";
          await setThreadEffort(entry.slug, threadTs, "");
        }
      } else {
        const patch = { model: val };
        if (!effortBelongsToModel(meta.effort, engine, val)) patch.effort = "";
        effortCurrent = (await patchChannelRuntime(patch)).effort || "";
      }
      await repaint(modelWizardEffortBlocks({ scope, threadTs, engine, model: val, current: effortCurrent, isDM }));
      return;
    }

    // Step 4 → done: effort picked.
    if (isPickerAction(actionId, EFFORT_PICKER_ACTION)) {
      const currentModel = scope === "thread"
        ? await getThreadModel(entry.slug, threadTs)
        : effectiveMeta(meta).model || "";
      if (!effortOptionsForEngine(engine, currentModel).some((o) => o.value === (val || DEFAULT_PICKER_VALUE))) {
        await ephemeral("That effort value is not allowed.");
        return;
      }
      let model = "";
      if (scope === "thread") {
        await setThreadEffort(entry.slug, threadTs, val);
        model = await getThreadModel(entry.slug, threadTs);
      } else {
        model = (await patchChannelRuntime({ effort: val })).model || "";
      }
      await updateRuntimePickerMessage({
        client,
        respond,
        channel,
        ts,
        text: `Runtime updated for ${wizardScopeLabel(scope, isDM)}. Harness: ${engine}. Model: ${model || "default"}. Effort: ${val || "default"}.`,
        blocks: modelWizardDoneBlocks({ scope, threadTs, isDM, engine, model, effort: val }),
      });
    }
  } catch (e) {
    console.error("[slack] model wizard error:", e.message);
    if (channel) await ephemeral("Couldn't update runtime settings — check the gateway logs.");
  }
}
