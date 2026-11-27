import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { REPLY_MENTIONS_HOME_TOGGLE_ACTION, replyMentionsHomeBlocks, registerReplyMentionsHomeActions } = await import("../src/slack/home-reply-mentions.js");
const { getUser, setUser } = await import("../src/config/store.js");

function toggleHandler(publishHome) {
  let handler;
  registerReplyMentionsHomeActions({ action: (id, fn) => {
    assert.equal(id, REPLY_MENTIONS_HOME_TOGGLE_ACTION);
    handler = fn;
  } }, { publishHome });
  return handler;
}

test("Home defaults reply mentions off and offers the opposite action", () => {
  for (const enabled of [false, true]) {
    const block = replyMentionsHomeBlocks({ enabled })[0];
    assert.match(block.text.text, enabled ? /— on/ : /— off/);
    assert.equal(block.accessory.action_id, REPLY_MENTIONS_HOME_TOGGLE_ACTION);
    assert.equal(block.accessory.value, enabled ? "off" : "on");
  }
  assert.equal(replyMentionsHomeBlocks()[0].accessory.value, "on");
});

test("reply mention toggles update only the authenticated actor and preserve other user fields", async () => {
  await setUser("U_SELF", { name: "Self", approved: true, nudges: true, composioToken: "fixture-token", replyMentions: false });
  await setUser("U_TARGET", { name: "Other", replyMentions: false });
  const published = [];
  let acked = 0;
  const handler = toggleHandler(async (_client, userId) => published.push(userId));
  for (const value of ["on", "off"]) {
    const before = await getUser("U_SELF");
    await handler({ ack: async () => { acked++; }, body: { user: { id: "U_SELF" }, userId: "U_TARGET", value: "U_TARGET" },
      action: { value, userId: "U_TARGET" }, client: {} });
    assert.deepEqual(await getUser("U_SELF"), { ...before, replyMentions: value === "on" });
    assert.equal((await getUser("U_TARGET")).replyMentions, false);
  }
  assert.equal(acked, 2);
  assert.deepEqual(published, ["U_SELF", "U_SELF"]);
});

test("invalid reply mention values and missing actors are acknowledged without writes", async () => {
  await setUser("U_INVALID", { replyMentions: true });
  const before = await getUser("U_INVALID");
  const handler = toggleHandler(async () => assert.fail("invalid actions cannot publish"));
  for (const [body, value] of [[{ user: { id: "U_INVALID" } }, "surprise"], [{ user: { id: "U_INVALID" } }, true], [{ userId: "U_INVALID" }, "off"]]) {
    let acked = false;
    await handler({ ack: async () => { acked = true; }, body, action: { value }, client: {} });
    assert.equal(acked, true);
  }
  assert.deepEqual(await getUser("U_INVALID"), before);
});
