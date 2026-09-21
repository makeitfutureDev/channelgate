// Slack App Home owns the user's self-service reminder switch. It may update only the clicking
// user's record, and immediately republishes Home so the visible state matches the saved value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const {
  NUDGE_HOME_TOGGLE_ACTION,
  nudgeHomeBlocks,
  registerNudgeHomeActions,
} = await import("../src/slack/home-nudges.js");
const { getUser, setUser } = await import("../src/config/store.js");

function makeApp() {
  const actions = new Map();
  return { actions, action: (id, fn) => actions.set(id, fn) };
}

test("Home renders the opposite action for the current personal state", () => {
  const off = nudgeHomeBlocks({ enabled: false })[0];
  assert.match(off.text.text, /off/);
  assert.equal(off.accessory.action_id, NUDGE_HOME_TOGGLE_ACTION);
  assert.equal(off.accessory.value, "on");
  assert.match(off.accessory.text.text, /Turn on/);

  const on = nudgeHomeBlocks({ enabled: true })[0];
  assert.match(on.text.text, /on/);
  assert.equal(on.accessory.value, "off");
  assert.match(on.accessory.text.text, /Turn off/);
});

test("the Home action changes only the clicking user's preference and republishes their view", async () => {
  await setUser("U_CLICK", { name: "Click", nudges: false });
  await setUser("U_OTHER", { name: "Other", nudges: true });
  const app = makeApp();
  const published = [];
  registerNudgeHomeActions(app, { publishHome: async (_client, userId) => published.push(userId) });

  let acked = 0;
  await app.actions.get(NUDGE_HOME_TOGGLE_ACTION)({
    ack: async () => { acked++; },
    body: { user: { id: "U_CLICK" } },
    action: { value: "on" },
    client: {},
  });

  assert.equal(acked, 1);
  assert.equal((await getUser("U_CLICK")).nudges, true);
  assert.equal((await getUser("U_OTHER")).nudges, true);
  assert.deepEqual(published, ["U_CLICK"]);
});

test("a forged toggle value is acknowledged but changes nothing", async () => {
  await setUser("U_FORGED", { nudges: false });
  const app = makeApp();
  registerNudgeHomeActions(app, { publishHome: async () => assert.fail("must not republish") });

  await app.actions.get(NUDGE_HOME_TOGGLE_ACTION)({
    ack: async () => {},
    body: { user: { id: "U_FORGED" } },
    action: { value: "surprise" },
    client: {},
  });
  assert.equal((await getUser("U_FORGED")).nudges, false);
});
