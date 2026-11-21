import { assertEngineSelectable } from "../engines/selection.js";
// The /model wizard (extracted from slack/app.js — the 2026-08 restructure notes (internal repo) Phase 2.3).
// ONE command for the whole runtime (the old /engine and /effort are folded in): /model walks
// through four steps in a single message that updates in place —
//   1. scope   — "This channel" or "Just this thread" (buttons)
//   2. harness — Claude Code / Codex (buttons; "Use defaults" clears the scope's overrides and ends)
//      license — only when the chosen harness has more than one license this conversation can use:
//                "Any license" or one of them (buttons), and for a specific license the others to
//                move to when it fails (a multi-select, then Continue)
//   3. model   — buttons, one per model, filtered to the chosen license
//   4. effort  — buttons, one per effort level, filtered to the chosen license
// Every choice is a button — the one dropdown is the optional "also use" list. Each step persists the
// moment it's clicked, so abandoning mid-wizard keeps the steps already
// taken. Steps 2-4 also carry a "← Back" button (and the done card a "Change again"), which walks
// the same message to an earlier step so a mis-click is corrected by re-picking rather than by
// re-running /model. Channel scope writes meta.engine/model/effort (what the old pickers did); thread scope
// writes the per-thread overrides (thread-engine.js), which beat the channel at run time. The
// license step writes `licensePool` beside the engine at the same level (license-pool.js). A channel
// pick made from inside a thread applies to THAT thread as well — see applyChannelRuntimeToThread;
// "this channel" is not "every thread except the one you are standing in". Wizard
// state ({s: scope, t: threadTs}) rides inside every button/option value as compact JSON, because
// the registered-slash-command variant is an ephemeral message with no body.message to read a
// thread from on the next click.
import { getChannelEntry, getChannelMeta, patchChannelMeta, isAdmin, isApproved } from "../config/store.js";
// A channel-scope runtime pick (engine / model / effort) is a policy change — audited like the
// admin UI's save and the `/mode` command (config/channel-audit.js). Thread-scope picks are not:
// they live in the thread override store, never in the channel's meta.
import { logChannelPolicyChange } from "../config/channel-audit.js";
import { assertChannelEngineApproved } from "../gateway/channel-engines.js";
import { getEngine, getEnginePool, canChangeChannelRuntime } from "../config/settings.js";
import { effectiveMeta } from "../gateway/run.js";
import { isAuthorized } from "../gateway/modes.js";
import { setThreadEngine, getThreadEngine, getThreadLicensePool, setThreadModel, getThreadModel, setThreadEffort, getThreadEffort } from "../gateway/thread-engine.js";
// Which harness MINTED the thread's live session. A channel-scope pick made inside a thread has
// to know that before it can move the thread — see applyChannelRuntimeToThread below.
import { getSessionEngine } from "../gateway/sessions.js";
import { ENGINE_IDS, adapterFor, harnessOf, requireAdapter, isLicenseListedModel, modelBelongsToEngine, effortBelongsToEngine, effortBelongsToModel, effortsForModel, modelsForEngine, refreshEngineModels } from "../engines/registry.js";
import { HARNESS_IDS, LICENSE_POOL_ANY, harnessLabel, isHarnessId } from "../engines/license-state.js";
import { ALSO_USE_LABEL, LICENSE_HELP_TEXT, clipLabel, harnessChoices, licenseChoices, namedSelection, nextLicenseSelection, selectionLabel, storedSelectionFor } from "./license-controls.js";
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
export const MODEL_WIZARD_BACK_LICENSE_ACTION = "cg_mw_back_license"; // → the license step
export const MODEL_WIZARD_BACK_ACTION_PATTERN = /^cg_mw_back_(?:scope|engine|license|model)$/;
// The license step (only for a harness with more than one usable license). One button per choice
// (`cg_mw_license_0` = "Any license", then each license), the "also use" multi-select, and
// Continue. A multi-select with nothing selected carries no option value, so its wizard state
// rides in the section's block_id instead (`cg_mw_also|<state>`).
export const MODEL_WIZARD_LICENSE_ACTION = "cg_mw_license";
export const MODEL_WIZARD_LICENSE_ACTION_PATTERN = /^cg_mw_license_\d+$/;
export const MODEL_WIZARD_ALSO_ACTION = "cg_mw_also";
export const MODEL_WIZARD_LICENSE_DONE_ACTION = "cg_mw_license_done";
const ALSO_BLOCK_PREFIX = `${MODEL_WIZARD_ALSO_ACTION}|`;
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
// Buttons and dropdowns already posted to Slack retain their old values after a deployment.
const LEGACY_CLAUDE_PICKER_VALUES = new Set(["best", "opus", "opus[1m]", "sonnet", "sonnet[1m]", "haiku", "fable", "opusplan"]);

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
  // A stored license that was deleted since falls back to the gateway default — what a turn here
  // runs on — before the first registered engine, which is nobody's choice.
  return [meta.engine, getEngine()].map((id) => String(id || "").toLowerCase()).find((id) => adapterFor(id)) || ENGINE_IDS[0];
}

export function modelOptionsForEngine(engine, current = "") {
  const options = [MODEL_DEFAULT_OPTION, ...modelsForEngine(engine)];
  // A saved alias or older full ID remains visible and selectable while this scope uses it.
  if (current && (isValidModel(current) || isLicenseListedModel(current, engine)) && modelBelongsToEngine(current, engine) && !options.some((option) => option.value === current)) {
    options.push({ label: `Current: ${current.slice(0, 66)}`, value: current, description: "Previously selected model." });
  }
  return options;
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

// Only harnesses with a license this conversation can run on are offered (license-pool.js: switched
// on in Settings, approved for the channel, available here) — the wizard must not hand someone a
// button that writes an override the orchestrator will immediately substitute away. The intro line
// names both harnesses when a policy leaves none, so the sentence still reads.
const OFFERED_HARNESSES = (meta = {}) => harnessChoices(meta);
const ENGINE_LABELS = (meta = {}) => {
  const offered = OFFERED_HARNESSES(meta).map((choice) => choice.label);
  return (offered.length ? offered : HARNESS_IDS.map(harnessLabel)).join(" / ");
};
export const modelWizardText = (meta = {}) => `Change the model: pick scope, then harness (${ENGINE_LABELS(meta)}), then model, then effort.`;

export const RETIRED_COMMAND_TEXT = (cmd) => `\`${cmd}\` was removed — \`/model\` now does it all: scope (channel or just this thread) → harness (${ENGINE_LABELS()}) → model → effort.`;

function wizardButton(actionId, label, value) {
  return { type: "button", action_id: actionId, text: { type: "plain_text", text: clipLabel(label), emoji: false }, value };
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
          text: `Step 1 of 4 — scope, then harness (${ENGINE_LABELS(meta)}), model, effort.` + (threadTs ? " *This channel* covers this thread too." : " To change a single thread, run `/model` inside that thread."),
        },
      ],
    },
  ];
}

// `threadEngine` / `threadPool` are the thread's own pin (thread scope); the channel's selection
// is read from `meta`. The "Current" line names the stored selection in words.
export function modelWizardEngineBlocks({ scope, threadTs, meta, threadEngine = "", threadPool = "" }) {
  const button = (actionId, label) => wizardButton(actionId, label, encodeWizardState({ scope, threadTs }));
  const current = scope === "thread"
    ? (threadEngine ? selectionLabel({ engine: threadEngine, pool: threadPool, meta }) : "channel default")
    : (meta.engine ? selectionLabel({ engine: meta.engine, pool: meta.licensePool, meta }) : "gateway default");
  return [
    { type: "section", text: { type: "mrkdwn", text: `*Which harness?* — for ${wizardScopeLabel(scope, meta.isDM)}\nCurrent: \`${current}\`` } },
    {
      type: "actions",
      elements: [
        ...OFFERED_HARNESSES(meta).map((choice) => button(`cg_mw_engine_${choice.value}`, choice.label)),
        button(MODEL_WIZARD_ENGINE_RESET_ACTION, "Use defaults"),
        backButton(MODEL_WIZARD_BACK_SCOPE_ACTION, { scope, threadTs }),
      ],
    },
    { type: "context", elements: [{ type: "mrkdwn", text: "Step 2 of 4 — model and effort next. *Use defaults* instead clears the harness/model/effort overrides for this scope. *← Back* returns to the scope step." }] },
  ];
}

// The license step: which license of the chosen harness this scope runs on. Rendered only when
// that harness has more than one license usable here (licenseChoices returns null otherwise).
// "Any license" moves on at once. A specific license stays on this card, which then also offers
// the other licenses to move to when it fails; Continue goes on to the model.
export function modelWizardLicenseBlocks({ scope, threadTs, meta, engine, pool = "" }) {
  const license = licenseChoices({ engine, pool, meta });
  if (!license) return null;
  const elements = license.options.map((o, i) => {
    const button = wizardButton(`${MODEL_WIZARD_LICENSE_ACTION}_${i}`, o.value === license.selected ? `✓ ${o.label}` : o.label, encodeWizardState({ scope, threadTs, value: o.value }));
    return o.value === license.selected ? { ...button, style: "primary" } : button;
  });
  const specific = license.selected !== LICENSE_POOL_ANY;
  const others = specific ? license.others.map((o) => ({ text: { type: "plain_text", text: clipLabel(o.label), emoji: false }, value: o.value })) : [];
  const initial = others.filter((o) => license.also.includes(o.value));
  return [
    { type: "section", text: { type: "mrkdwn", text: `*Which ${harnessLabel(license.harness)} license?* — for ${wizardScopeLabel(scope, meta.isDM)}\nCurrent: \`${selectionLabel({ engine, pool, meta })}\`` } },
    ...actionRows(elements),
    ...(others.length ? [{
      type: "section",
      block_id: `${ALSO_BLOCK_PREFIX}${encodeWizardState({ scope, threadTs })}`,
      text: { type: "mrkdwn", text: `*${ALSO_USE_LABEL}*` },
      accessory: {
        type: "multi_static_select", action_id: MODEL_WIZARD_ALSO_ACTION,
        placeholder: { type: "plain_text", text: "No other license", emoji: false }, options: others,
        // Slack refuses a message whose `initial_options` is an empty list.
        ...(initial.length ? { initial_options: initial } : {}),
      },
    }] : []),
    { type: "actions", elements: [
      wizardButton(MODEL_WIZARD_LICENSE_DONE_ACTION, "Continue →", encodeWizardState({ scope, threadTs })),
      backButton(MODEL_WIZARD_BACK_ENGINE_ACTION, { scope, threadTs }),
    ] },
    { type: "context", elements: [{ type: "mrkdwn", text: `Step 2 of 4, continued — this harness has more than one license. *Any license* uses whichever can answer. ${LICENSE_HELP_TEXT} *Continue* goes on to the model. *← Back* returns to the harness step.` }] },
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

// `licenseStep`: the scope's harness has a license step, so Back returns there.
export function modelWizardModelBlocks({ scope, threadTs, engine, current, isDM, locked = false, licenseStep = false }) {
  return wizardChoiceBlocks({
    scope,
    threadTs,
    actionId: MODEL_PICKER_ACTION,
    options: modelOptionsForEngine(engine, current),
    current,
    backActionId: locked ? MODEL_WIZARD_BACK_SCOPE_ACTION : licenseStep ? MODEL_WIZARD_BACK_LICENSE_ACTION : MODEL_WIZARD_BACK_ENGINE_ACTION,
    header: `*Choose a ${requireAdapter(engine).label} model* — for ${wizardScopeLabel(scope, isDM)}\nCurrent: \`${current || "default"}\``,
    step: locked
      ? "Step 2 of 3 — effort next. *Gateway default* clears the model override. *← Back* returns to scope."
      : `Step 3 of 4 — effort next. *Gateway default* clears the model override. *← Back* returns to the ${licenseStep ? "license" : "harness"} step.`,
  });
}

export function modelWizardEffortBlocks({ scope, threadTs, engine, model, current, isDM, locked = false }) {
  return wizardChoiceBlocks({
    scope,
    threadTs,
    actionId: EFFORT_PICKER_ACTION,
    options: effortOptionsForEngine(engine, model),
    current,
    backActionId: MODEL_WIZARD_BACK_MODEL_ACTION,
    header: `*Choose reasoning effort* — for ${wizardScopeLabel(scope, isDM)}\nModel: \`${model || "default"}\` · Current effort: \`${current || "default"}\``,
    step: `${locked ? "Step 3 of 3" : "Step 4 of 4"} — done after this. *Engine default* clears the override. *← Back* returns to the model step.`,
  });
}

// `selection` is the stored selection in words ("Codex · Work, then Second"); `movedThread` is
// "harness" or "license" — what the thread this channel pick was made in was moved off.
function modelWizardDoneBlocks({ scope, threadTs, isDM, engine, selection = "", model, effort, reset = false, movedThread = "" }) {
  const where = wizardScopeLabel(scope, isDM);
  // A channel pick applies to the thread it was made in as well. Say so only when that cost
  // something: the thread was on the other harness (or another license of this one — a session
  // belongs to the license that started it), so it restarts there with its earlier messages
  // replayed instead of resuming its own session.
  const moved = movedThread
    ? `\n_This thread was on another ${movedThread === "license" ? "license" : "harness"} — your next message here starts a fresh ${requireAdapter(engine).label} session, with the thread's earlier messages replayed as context._`
    : "";
  const text = reset
    ? `✅ Cleared — ${where} now follows the ${scope === "thread" ? "channel's" : "gateway's"} default harness, model, and effort.`
    : `✅ Runtime updated for ${where}\nHarness: *${selection || requireAdapter(engine).label}* · Model: \`${model || "default"}\` · Effort: \`${effort || "default"}\`${moved}`;
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
    text: modelWizardText(meta),
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
  // The "also use" multi-select has no single value (and none at all once emptied): its wizard
  // state rides in the block_id of the section that carries it.
  const raw = actionId === MODEL_WIZARD_ALSO_ACTION
    ? String(action?.block_id || "").slice(ALSO_BLOCK_PREFIX.length)
    : action?.selected_option?.value ?? action?.value;
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

    const repaint = (blocks) => updateRuntimePickerMessage({ client, respond, channel, ts, text: modelWizardText(meta), blocks });
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
    // Model/effort half of the above. The harness pin (when there is one) has to survive a later
    // step: steps 3 and 4 re-clear the values they are about to let the channel supply, they do
    // not undo the thread move step 2 made.
    const clearThreadModelEffort = async () => {
      await setThreadModel(entry.slug, threadTs, "");
      await setThreadEffort(entry.slug, threadTs, "");
    };
    // "This channel" clicked from INSIDE a thread means this thread too — not only the threads
    // opened after it. Two halves:
    //   • drop the thread's own engine/model/effort overrides, so nothing shadows the channel
    //     values just written (an earlier "claude"/"codex" directive, an earlier thread-scope run);
    //   • move a live session the OTHER harness minted. run.js deliberately keeps such a thread on
    //     its own engine when a channel/global DEFAULT changes (decideThreadEngine): a session id
    //     cannot resume cross-engine, so a flipped default must never reset live conversations.
    //     Clicking the wizard inside the thread is not a default though — it is an explicit ask for
    //     HERE, so the thread is pinned to the chosen harness exactly as an in-thread
    //     "claude"/"codex" directive pins it, and run.js starts a fresh session while the pipeline
    //     replays the thread's earlier messages into it. Without the pin the chosen model is lost
    //     too: run.js drops a model that doesn't belong to the engine the turn actually runs on,
    //     so the thread would answer on its old harness's default model.
    //     The pin is written ONLY when the session really is on the other harness — a thread whose
    //     session already matches (or has none yet) stays unpinned, so it keeps following the
    //     channel and keeps its cross-engine failover.
    //     The pin carries the channel selection's other licenses with it, so the moved thread can
    //     still move between them.
    const applyChannelRuntimeToThread = async (engine, licensePool = "") => {
      const minted = await getSessionEngine(entry.slug, threadTs).catch(() => "");
      await clearThreadOverrides();
      if (minted && minted !== engine) await setThreadEngine(entry.slug, threadTs, engine, { licensePool });
    };

    // ── The license selection of this wizard's scope ──────────────────────────────────────────
    // effectiveMeta: what this conversation can run on (its approved harnesses, its own Codex
    // sign-in) and, for a template-managed DM, the selection the org template supplies.
    const effective = effectiveMeta(meta);
    // What the scope itself stores: the thread's pin, or the conversation's own record.
    const storedSelection = async () => scope === "thread"
      ? { engine: await getThreadEngine(entry.slug, threadTs), licensePool: await getThreadLicensePool(entry.slug, threadTs) }
      : { engine: meta.engine || "", licensePool: meta.licensePool || "" };
    const hasLicenseStep = (stored) => Boolean(licenseChoices({ engine: stored.engine, pool: stored.licensePool, meta: effective }));
    // Persist a harness/license pick at the scope, clearing any stored model/effort that doesn't
    // belong to the new engine (they flow straight into --model / effort flags, so a leftover from
    // another harness would break every turn). Returns the model still in force there.
    const persistSelection = async ({ engine, licensePool }) => {
      if (scope === "thread") {
        await setThreadEngine(entry.slug, threadTs, engine, { licensePool });
        const tm = await getThreadModel(entry.slug, threadTs);
        if (!effortBelongsToEngine(await getThreadEffort(entry.slug, threadTs), engine)) await setThreadEffort(entry.slug, threadTs, "");
        if (modelBelongsToEngine(tm, engine)) return tm;
        await setThreadModel(entry.slug, threadTs, "");
        return "";
      }
      // The store keeps a pool beside whatever engine is saved, so the pool is always written
      // with the license it belongs to — "" when there is none.
      const patch = { engine, licensePool };
      if (!modelBelongsToEngine(meta.model, engine)) patch.model = "";
      if (!effortBelongsToEngine(meta.effort, engine)) patch.effort = "";
      const next = await patchChannelRuntime(patch);
      // The channel choice governs the thread it was made in, not just threads opened later.
      if (threadTs) await applyChannelRuntimeToThread(engine, licensePool);
      return next.model || "";
    };
    const paintHarnessStep = async (chosen = scope) => {
      const pinned = chosen === "thread";
      await repaint(modelWizardEngineBlocks({
        scope: chosen, threadTs, meta: effective,
        threadEngine: pinned ? await getThreadEngine(entry.slug, threadTs) : "",
        threadPool: pinned ? await getThreadLicensePool(entry.slug, threadTs) : "",
      }));
    };
    // False when the stored harness has a single usable license here: there is no license step.
    const paintLicenseStep = async (stored) => {
      const blocks = modelWizardLicenseBlocks({ scope, threadTs, meta: effective, engine: stored.engine, pool: stored.licensePool });
      if (blocks) await repaint(blocks);
      return Boolean(blocks);
    };
    const paintModelStep = (stored, current) => repaint(modelWizardModelBlocks({ scope, threadTs, engine: stored.engine, current, isDM, licenseStep: hasLicenseStep(stored) }));

    // "← Back" / "Change again": repaint an EARLIER step in this same message. Nothing is written
    // or unwritten here — each step already persisted when it was clicked, and re-picking there
    // overwrites it. Every step is re-read from the store so the repainted card shows what is
    // actually in force right now (including the pick being corrected).
    if (actionId === MODEL_WIZARD_BACK_SCOPE_ACTION) {
      await repaint(modelWizardScopeBlocks({ threadTs, meta }));
      return;
    }
    if (actionId === MODEL_WIZARD_BACK_ENGINE_ACTION) {
      await paintHarnessStep();
      return;
    }
    if (actionId === MODEL_WIZARD_BACK_LICENSE_ACTION) {
      // The license step may be gone by now (a license was removed or switched off): fall back
      // to the harness step rather than repaint a card with nothing to choose.
      if (!(await paintLicenseStep(await storedSelection()))) await paintHarnessStep();
      return;
    }
    if (actionId === MODEL_WIZARD_BACK_MODEL_ACTION) {
      const backEngine = (scope === "thread" ? await getThreadEngine(entry.slug, threadTs) : "") || runtimeEngine(effective);
      const backModel = (scope === "thread" ? await getThreadModel(entry.slug, threadTs) : meta.model) || "";
      await repaint(modelWizardModelBlocks({ scope, threadTs, engine: backEngine, current: backModel, isDM, licenseStep: hasLicenseStep(await storedSelection()) }));
      return;
    }

    // Step 1 → 2: scope picked. (A thread pick with no resolvable thread was already refused above.)
    if (actionId === MODEL_WIZARD_SCOPE_CHANNEL_ACTION || actionId === MODEL_WIZARD_SCOPE_THREAD_ACTION) {
      await paintHarnessStep(actionId === MODEL_WIZARD_SCOPE_THREAD_ACTION ? "thread" : "channel");
      return;
    }

    // Step 2 shortcut: "Use defaults" clears every override for the scope and ends the wizard.
    if (actionId === MODEL_WIZARD_ENGINE_RESET_ACTION) {
      if (scope === "thread") {
        await clearThreadOverrides();
      } else {
        await patchChannelRuntime({ engine: "", licensePool: "", model: "", effort: "" });
        // A channel-wide reset asked for from inside a thread also drops that thread's own
        // overrides, so the reset visibly applies right where it was requested.
        if (threadTs) await clearThreadOverrides();
      }
      await updateRuntimePickerMessage({ client, respond, channel, ts, text: "Runtime overrides cleared.", blocks: modelWizardDoneBlocks({ scope, threadTs, isDM, reset: true }) });
      return;
    }

    // Step 2 → 3: harness picked. Persist it at once — the license and the further licenses this
    // scope already had for that harness stay (a thread keeps its own pin's), else what the
    // conversation runs that harness on (license-pool.js harnessSelection). A button naming a
    // LICENSE id (cards posted before the license step existed) pins exactly that license.
    if (actionId.startsWith("cg_mw_engine_") && actionId !== MODEL_WIZARD_ENGINE_RESET_ACTION) {
      const name = actionId.slice("cg_mw_engine_".length);
      if (!adapterFor(name)) throw new Error(`Unknown engine choice: ${name}`);
      const own = isHarnessId(name) && scope === "thread" ? storedSelectionFor(name, await storedSelection(), effective) : null;
      const selection = own || namedSelection(name, effective);
      assertChannelEngineApproved(meta, selection.engine);
      await assertEngineSelectable(selection.engine, { meta });
      const current = await persistSelection(selection);
      // The authenticated CLI is the source of truth for selectable Codex models. Refresh only
      // when its bounded cache is stale; failure keeps the last known-good/static catalog.
      await refreshEngineModels(selection.engine);
      // More than one license of this harness is usable here: ask which before the model.
      if (isHarnessId(name) && await paintLicenseStep(selection)) return;
      await paintModelStep(selection, current);
      return;
    }

    // The license step. Every click persists, like every other step.
    if (MODEL_WIZARD_LICENSE_ACTION_PATTERN.test(actionId) || actionId === MODEL_WIZARD_ALSO_ACTION) {
      const stored = await storedSelection();
      // A card left on screen after the scope went back to its default, or after the other
      // licenses were removed: there is nothing to choose between any more.
      if (!hasLicenseStep(stored)) {
        await ephemeral("That license choice is no longer available — pick the harness again.");
        await paintHarnessStep();
        return;
      }
      const selection = actionId === MODEL_WIZARD_ALSO_ACTION
        ? nextLicenseSelection({ field: "also", also: (action?.selected_options || []).map((o) => String(o?.value || "")).filter(Boolean), current: stored, meta: effective })
        : nextLicenseSelection({ field: "license", value: String(state.value || ""), current: stored, meta: effective });
      assertChannelEngineApproved(meta, selection.engine);
      await assertEngineSelectable(selection.engine, { meta });
      const current = await persistSelection(selection);
      await refreshEngineModels(selection.engine);
      // "Any license" has nothing more to ask. A specific license stays on this card, which now
      // offers the other licenses to move to; Continue goes on.
      if (selection.licensePool === LICENSE_POOL_ANY || !(await paintLicenseStep(selection))) await paintModelStep(selection, current);
      return;
    }
    if (actionId === MODEL_WIZARD_LICENSE_DONE_ACTION) {
      const stored = await storedSelection();
      if (!stored.engine || !adapterFor(stored.engine)) {
        await paintHarnessStep();
        return;
      }
      const model = (scope === "thread" ? await getThreadModel(entry.slug, threadTs) : meta.model) || "";
      await paintModelStep(stored, modelBelongsToEngine(model, stored.engine) ? model : "");
      return;
    }

    // Steps 3 + 4 read the harness back from what step 2 persisted (also correct for the legacy
    // pre-wizard dropdowns, which were always channel-scope on the channel's engine).
    // effectiveMeta: a template-managed DM takes its engine from the org template, as run.js will.
    const engine = (scope === "thread" ? await getThreadEngine(entry.slug, threadTs) : "") || runtimeEngine(effective);
    const val = decodePickerValue(state.value);

    // Step 3 → 4: model picked.
    if (isPickerAction(actionId, MODEL_PICKER_ACTION)) {
      const currentModel = scope === "thread" ? await getThreadModel(entry.slug, threadTs) : meta.model || "";
      const offered = modelOptionsForEngine(engine, currentModel).some((o) => o.value === (val || DEFAULT_PICKER_VALUE));
      if (!offered && !(harnessOf(engine) === "claude" && LEGACY_CLAUDE_PICKER_VALUES.has(val) && modelBelongsToEngine(val, engine))) {
        await ephemeral("That model does not belong to the chosen harness.");
        return;
      }
      if (val && !isValidModel(val) && !isLicenseListedModel(val, engine)) {
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
        // Also for the thread this was clicked in: step 2 already cleared these, but the step is
        // reachable on its own (← Back, or a pre-wizard dropdown still sitting in Slack history).
        if (threadTs) await clearThreadModelEffort();
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
        if (threadTs) await clearThreadModelEffort();
      }
      // A harness pin on a channel-scope pick only exists because step 2 MOVED this thread onto
      // the chosen harness (applyChannelRuntimeToThread) — report that, since the move costs the
      // thread its current engine session. A session belongs to the license that started it, so
      // a move between two licenses of one harness costs the same and is named as what it is.
      const pinnedHere = scope === "channel" && threadTs ? await getThreadEngine(entry.slug, threadTs) : "";
      const minted = pinnedHere ? await getSessionEngine(entry.slug, threadTs).catch(() => "") : "";
      const movedThread = !pinnedHere ? "" : minted && minted !== engine && harnessOf(minted) === harnessOf(engine) ? "license" : "harness";
      // The selection in words: the scope's own license and the further ones beside it, else
      // what it inherits.
      const stored = await storedSelection();
      const pool = stored.engine === engine ? stored.licensePool : effective.engine === engine ? effective.licensePool || "" : engine === getEngine() ? getEnginePool() : "";
      const selection = selectionLabel({ engine, pool, meta: effective });
      await updateRuntimePickerMessage({
        client,
        respond,
        channel,
        ts,
        text: `Runtime updated for ${wizardScopeLabel(scope, isDM)}. Harness: ${selection}. Model: ${model || "default"}. Effort: ${val || "default"}.`,
        blocks: modelWizardDoneBlocks({ scope, threadTs, isDM, engine, selection, model, effort: val, movedThread }),
      });
    }
  } catch (e) {
    console.error("[slack] model wizard error:", e.message);
    if (channel) await ephemeral(e.code === "engine_selection_unavailable" || e.code === "invalid_license_pool" ? e.message : "Couldn't update runtime settings — check the gateway logs.");
  }
}
