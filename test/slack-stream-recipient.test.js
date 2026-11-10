import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStreamRecipientTeam } from "../src/slack/stream-recipient.js";

test("Slack Connect uses sender workspace without a lookup when event supplies it", async () => {
  const client = { users: { info: async () => { throw new Error("unnecessary lookup"); } } };
  assert.equal(await resolveStreamRecipientTeam(client, { user: "U1", user_team: "T_EXTERNAL", team: "T_BOT" }, "T_BOT"), "T_EXTERNAL");
});
test("sender lookup resolves and caches external workspace independently per client", async () => {
  let calls = 0;
  const client = { users: { info: async () => { calls++; return { user: { id: "U1", team_id: "T_EXTERNAL" } }; } } };
  for (let i = 0; i < 2; i++) assert.equal(await resolveStreamRecipientTeam(client, { user: "U1" }, "T_BOT"), "T_EXTERNAL");
  assert.equal(calls, 1);
  assert.equal(await resolveStreamRecipientTeam({ users: { info: async () => ({ user: { id: "U1", team_id: "T_OTHER" } }) } }, { user: "U1" }, "T_BOT"), "T_OTHER");
});
test("missing or mismatched lookup preserves fallback without caching a false owner", async () => {
  const client = { users: { info: async () => ({ user: { id: "OTHER", team_id: "T_WRONG" } }) } };
  assert.equal(await resolveStreamRecipientTeam(client, { user: "U1" }, "T_BOT"), "T_BOT");
  assert.equal(await resolveStreamRecipientTeam({}, { user: "U1" }, "T_BOT"), "T_BOT");
});
