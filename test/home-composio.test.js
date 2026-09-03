// App Home → "Connect my Composio key". The point of this surface is that a personal token can be
// attached WITHOUT pasting it into a Slack message (where it lingers in history and search), so the
// tests pin the two properties that make it safe — the modal never renders a stored key back, and a
// rejected submission stores nothing — plus the save/clear round trip and the Home re-render.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const {
  composioTokenError,
  composioHomeButtons,
  buildComposioTokenModal,
  registerComposioHomeActions,
  COMPOSIO_HOME_SET_ACTION,
  COMPOSIO_HOME_CLEAR_ACTION,
  COMPOSIO_HOME_MODAL,
  COMPOSIO_TOKEN_BLOCK,
  COMPOSIO_TOKEN_INPUT,
  COMPOSIO_LABEL_BLOCK,
  COMPOSIO_LABEL_INPUT,
} = await import("../src/slack/home-composio.js");
const { getUser, setUser } = await import("../src/config/store.js");

// Minimal Bolt stand-in: records the handlers so a test can invoke one directly.
function makeApp() {
  const actions = new Map();
  const views = new Map();
  return {
    actions,
    views,
    action: (id, fn) => actions.set(id, fn),
    view: (id, fn) => views.set(id, fn),
  };
}

const viewState = (token, label) => ({
  state: {
    values: {
      [COMPOSIO_TOKEN_BLOCK]: { [COMPOSIO_TOKEN_INPUT]: { value: token } },
      [COMPOSIO_LABEL_BLOCK]: { [COMPOSIO_LABEL_INPUT]: { value: label } },
    },
  },
});

test("token validation rejects empty, too-short and whitespace-bearing keys", () => {
  assert.match(composioTokenError(""), /Paste your Composio/);
  assert.match(composioTokenError("abc"), /valid Composio key/);
  assert.match(composioTokenError("ak_with space"), /spaces or line breaks/);
  assert.equal(composioTokenError("ak_live_abcdef123"), "");
});

test("the Home buttons follow the connection state, and vanish in SDK mode", () => {
  const fresh = composioHomeButtons({ hasToken: false });
  assert.equal(fresh.length, 1);
  assert.deepEqual(fresh[0].elements.map((e) => e.action_id), [COMPOSIO_HOME_SET_ACTION]);
  assert.match(fresh[0].elements[0].text.text, /Connect/);

  const connected = composioHomeButtons({ hasToken: true });
  assert.deepEqual(connected[0].elements.map((e) => e.action_id), [COMPOSIO_HOME_SET_ACTION, COMPOSIO_HOME_CLEAR_ACTION]);
  assert.ok(connected[0].elements[1].confirm, "disconnect asks for confirmation");

  // SDK mode mints the identity at run time — a button that writes an unread token would lie.
  assert.deepEqual(composioHomeButtons({ hasToken: true, enabled: false }), []);
});

test("the modal never pre-fills the stored key, but does carry the label", () => {
  const view = buildComposioTokenModal({ hasToken: true, label: "work account" });
  const tokenInput = view.blocks.find((b) => b.block_id === COMPOSIO_TOKEN_BLOCK).element;
  const labelInput = view.blocks.find((b) => b.block_id === COMPOSIO_LABEL_BLOCK).element;
  assert.equal(tokenInput.initial_value, undefined, "a secret is never rendered back into the view");
  assert.equal(labelInput.initial_value, "work account");
  assert.equal(view.callback_id, COMPOSIO_HOME_MODAL);
  assert.ok(!JSON.stringify(view).includes("ak_live"), "no token value anywhere in the view");
});

test("submitting a valid key saves it for the submitter and re-renders Home", async () => {
  const published = [];
  const app = makeApp();
  registerComposioHomeActions(app, { publishHome: async (_client, userId) => published.push(userId) });

  const acks = [];
  await app.views.get(COMPOSIO_HOME_MODAL)({
    ack: async (payload) => acks.push(payload),
    body: { user: { id: "U_HOME_1" } },
    view: viewState("  ak_live_secret_123  ", " work account "),
    client: {},
  });

  assert.deepEqual(acks, [undefined], "a clean save acks with no errors");
  const saved = await getUser("U_HOME_1");
  assert.equal(saved.composioToken, "ak_live_secret_123", "the value is trimmed, not mangled");
  assert.equal(saved.composioTokenLabel, "work account");
  assert.deepEqual(published, ["U_HOME_1"], "Home re-renders so the ✅ line updates");
});

test("a rejected submission reports the problem in-modal and stores nothing", async () => {
  const app = makeApp();
  const published = [];
  registerComposioHomeActions(app, { publishHome: async (_c, u) => published.push(u) });

  const acks = [];
  await app.views.get(COMPOSIO_HOME_MODAL)({
    ack: async (payload) => acks.push(payload),
    body: { user: { id: "U_HOME_2" } },
    view: viewState("nope", ""),
    client: {},
  });

  assert.equal(acks.length, 1);
  assert.equal(acks[0].response_action, "errors");
  assert.match(acks[0].errors[COMPOSIO_TOKEN_BLOCK], /valid Composio key/);
  assert.equal((await getUser("U_HOME_2"))?.composioToken || "", "");
  assert.deepEqual(published, [], "nothing changed, so nothing is re-published");
});

test("disconnect clears the key and its label", async () => {
  await setUser("U_HOME_3", { composioToken: "ak_live_bye_123", composioTokenLabel: "old" });
  const app = makeApp();
  const published = [];
  registerComposioHomeActions(app, { publishHome: async (_c, u) => published.push(u) });

  await app.actions.get(COMPOSIO_HOME_CLEAR_ACTION)({
    ack: async () => {},
    body: { user: { id: "U_HOME_3" } },
    client: {},
  });

  const after = await getUser("U_HOME_3");
  assert.equal(after.composioToken, "");
  assert.equal(after.composioTokenLabel, "");
  assert.deepEqual(published, ["U_HOME_3"]);
});

test("the set button opens the modal for the clicking user only", async () => {
  await setUser("U_HOME_4", { composioToken: "ak_live_existing_1", composioTokenLabel: "personal" });
  const app = makeApp();
  registerComposioHomeActions(app, { publishHome: async () => {} });

  const opened = [];
  await app.actions.get(COMPOSIO_HOME_SET_ACTION)({
    ack: async () => {},
    body: { user: { id: "U_HOME_4" }, trigger_id: "trig.1" },
    client: { views: { open: async (args) => opened.push(args) } },
  });

  assert.equal(opened.length, 1);
  assert.equal(opened[0].trigger_id, "trig.1");
  assert.match(opened[0].view.title.text, /Update Composio key/, "an existing key means an update, not a first connect");
  assert.ok(!JSON.stringify(opened[0].view).includes("ak_live_existing_1"), "the stored key never reaches Slack");
});
