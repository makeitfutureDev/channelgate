// Self-service Composio key entry from the App Home tab.
//
// Until now the only way for a non-admin to attach their PERSONAL Composio token was to paste it
// into a Slack message so `set_my_composio_token` could pick it up — which leaves the secret
// sitting in Slack history (and search) until the author remembers to delete that message. A modal
// is a private surface: the value never becomes a message, is never echoed back, and never rides a
// Home view. That makes this the preferred path; the DM tool stays as the fallback for people who
// are already in a conversation with the bot.
import { getUser, setUser } from "../config/store.js";
import { logEvent } from "../util/logger.js";

export const COMPOSIO_HOME_SET_ACTION = "cg_home_composio_set";
export const COMPOSIO_HOME_CLEAR_ACTION = "cg_home_composio_clear";
export const COMPOSIO_HOME_MODAL = "cg_home_composio_modal";
export const COMPOSIO_TOKEN_BLOCK = "cg_composio_token";
export const COMPOSIO_TOKEN_INPUT = "cg_composio_token_input";
export const COMPOSIO_LABEL_BLOCK = "cg_composio_label";
export const COMPOSIO_LABEL_INPUT = "cg_composio_label_input";

const MIN_TOKEN_LEN = 6;

export const normalizeComposioToken = (raw) => String(raw ?? "").trim();

// Same shape check the MCP tool applies, plus a whitespace guard: a key pasted with a stray line
// break silently authenticates as nothing at all, and the failure would only surface later as a
// dead MCP server mid-run.
export function composioTokenError(token) {
  if (!token) return "Paste your Composio API key.";
  if (token.length < MIN_TOKEN_LEN) return "That doesn't look like a valid Composio key.";
  if (/\s/.test(token)) return "The key can't contain spaces or line breaks — paste it exactly as Composio shows it.";
  return "";
}

// The Home tab's Composio controls. SDK mode mints an identity per user at run time, so there is
// no personal token to set — the buttons disappear rather than write a value nothing reads.
export function composioHomeButtons({ hasToken = false, enabled = true } = {}) {
  if (!enabled) return [];
  const elements = [
    {
      type: "button",
      action_id: COMPOSIO_HOME_SET_ACTION,
      text: { type: "plain_text", text: hasToken ? "Update my Composio key" : "Connect my Composio key", emoji: false },
      ...(hasToken ? {} : { style: "primary" }),
    },
  ];
  if (hasToken) {
    elements.push({
      type: "button",
      action_id: COMPOSIO_HOME_CLEAR_ACTION,
      style: "danger",
      text: { type: "plain_text", text: "Disconnect", emoji: false },
      confirm: {
        title: { type: "plain_text", text: "Disconnect Composio?" },
        text: { type: "mrkdwn", text: "Your personal Composio key will be removed. Your messages fall back to the shared account (if one is configured) until you connect again." },
        confirm: { type: "plain_text", text: "Disconnect" },
        deny: { type: "plain_text", text: "Keep it" },
      },
    });
  }
  return [{ type: "actions", block_id: "cg_home_composio_actions", elements }];
}

// The key input is deliberately NOT pre-filled with the stored value — a Home-tab modal must never
// become a way to read back a secret (same rule as the admin UI's reveal endpoint). The label is
// not a secret, so it round-trips.
export function buildComposioTokenModal({ hasToken = false, label = "" } = {}) {
  return {
    type: "modal",
    callback_id: COMPOSIO_HOME_MODAL,
    title: { type: "plain_text", text: hasToken ? "Update Composio key" : "Connect Composio" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            "Paste your Composio API key (`x-consumer-api-key`). It's stored on the gateway host and used as *your* identity (`composio-user`) whenever you run me.\n\n" +
            "Only you can see this dialog — unlike sending the key in a message, nothing here lands in Slack history." +
            (hasToken ? "\n\nSaving replaces the key you already have." : ""),
        },
      },
      {
        type: "input",
        block_id: COMPOSIO_TOKEN_BLOCK,
        label: { type: "plain_text", text: "Composio API key" },
        element: {
          type: "plain_text_input",
          action_id: COMPOSIO_TOKEN_INPUT,
          placeholder: { type: "plain_text", text: "ak_…" },
        },
      },
      {
        type: "input",
        block_id: COMPOSIO_LABEL_BLOCK,
        optional: true,
        label: { type: "plain_text", text: "Label (optional)" },
        element: {
          type: "plain_text_input",
          action_id: COMPOSIO_LABEL_INPUT,
          ...(label ? { initial_value: label } : {}),
          placeholder: { type: "plain_text", text: "e.g. work account" },
        },
        hint: { type: "plain_text", text: "Shown in the admin UI so accounts can be told apart — never the key itself." },
      },
    ],
  };
}

const inputValue = (view, blockId, actionId) => view?.state?.values?.[blockId]?.[actionId]?.value ?? "";

// `publishHome(client, userId)` re-renders the Home tab: the connection lines the user just changed
// are part of that view, so a save that doesn't re-publish looks like it didn't happen.
export function registerComposioHomeActions(app, { publishHome } = {}) {
  const republish = async (client, userId) => {
    if (typeof publishHome !== "function") return;
    try { await publishHome(client, userId); }
    catch (e) { console.error("[slack] composio home republish error:", e.message); }
  };

  app.action(COMPOSIO_HOME_SET_ACTION, async ({ ack, body, client }) => {
    await ack();
    const userId = body?.user?.id;
    if (!userId || !body?.trigger_id) return;
    try {
      const user = await getUser(userId);
      await client.views.open({
        trigger_id: body.trigger_id,
        view: buildComposioTokenModal({ hasToken: Boolean(user?.composioToken), label: user?.composioTokenLabel || "" }),
      });
    } catch (e) {
      console.error("[slack] composio key modal error:", e.message);
    }
  });

  app.action(COMPOSIO_HOME_CLEAR_ACTION, async ({ ack, body, client }) => {
    await ack();
    const userId = body?.user?.id;
    if (!userId) return;
    try {
      await setUser(userId, { composioToken: "", composioTokenLabel: "" });
      await logEvent("composio_token_cleared", { author: userId, via: "app_home" });
    } catch (e) {
      console.error("[slack] composio key clear error:", e.message);
      return;
    }
    await republish(client, userId);
  });

  app.view(COMPOSIO_HOME_MODAL, async ({ ack, body, view, client }) => {
    const userId = body?.user?.id;
    const token = normalizeComposioToken(inputValue(view, COMPOSIO_TOKEN_BLOCK, COMPOSIO_TOKEN_INPUT));
    const problem = userId ? composioTokenError(token) : "No user context — can't save a key here.";
    if (problem) {
      await ack({ response_action: "errors", errors: { [COMPOSIO_TOKEN_BLOCK]: problem } });
      return;
    }
    const label = normalizeComposioToken(inputValue(view, COMPOSIO_LABEL_BLOCK, COMPOSIO_LABEL_INPUT)).slice(0, 60);
    // Save BEFORE acking success: a storage failure the user was told nothing about would leave
    // them believing they're connected while every run still falls back to the shared account.
    try {
      await setUser(userId, { composioToken: token, composioTokenLabel: label });
      await logEvent("composio_token_set", { author: userId, via: "app_home" });
    } catch (e) {
      console.error("[slack] composio key save error:", e.message);
      await ack({ response_action: "errors", errors: { [COMPOSIO_TOKEN_BLOCK]: "Couldn't save the key — try again." } });
      return;
    }
    await ack();
    await republish(client, userId);
  });
}
