// Guards the bot-created Slack List binding (src/slack/lists.js): a List the bot creates has an
// EMPTY share set, so the files.info share check alone refused the create→populate flow's own
// List. Bot-created listIds are remembered in the creating channel's meta and honored by
// assertListInChannel BEFORE any Slack API call; unknown Lists still hit the share check (which
// fails closed here — no bot token in the test env).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { upsertChannelEntry, saveChannelMeta, getChannelMeta } = await import("../src/config/store.js");
const { assertListInChannel } = await import("../src/slack/lists.js");

const CHANNEL = "C_LISTS_BIND";
const SLUG = "lists-binding-test";

test("a remembered bot-created List is authorized for its channel without a files.info call", async () => {
  await upsertChannelEntry(CHANNEL, { name: SLUG, type: "channel", isDM: false });
  await saveChannelMeta(SLUG, { ...(await getChannelMeta(SLUG)), botLists: { F_BOT_LIST: CHANNEL } });
  // No Slack token exists in the test env, so reaching files.info would throw — resolving
  // proves the binding short-circuits ahead of the share check.
  assert.equal(await assertListInChannel("F_BOT_LIST", CHANNEL), null);
});

test("an unknown List still falls through to the share check (fail closed)", async () => {
  await assert.rejects(assertListInChannel("F_SOMEONE_ELSES", CHANNEL));
});

test("a bot List remembered for one channel does not authorize another", async () => {
  await upsertChannelEntry("C_OTHER_BIND", { name: "lists-binding-other", type: "channel", isDM: false });
  await assert.rejects(assertListInChannel("F_BOT_LIST", "C_OTHER_BIND"));
});
