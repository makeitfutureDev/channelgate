import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();

const settings = await import("../src/config/settings.js");
const { createSettingsRouter } = await import("../src/web/routes/settings.js");
const app = express();
app.use(express.json());
app.use(createSettingsRouter({ slack: { snapshot: () => ({ connected: false, status: "disconnected" }) } }));
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
after(() => { server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${server.address().port}`;
const put = async (patch) => {
  const response = await fetch(`${base}/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...patch, connectSlack: false }) });
  return { status: response.status, body: await response.json() };
};

test("platform defaults remain independent and preserve the Slack default", () => {
  assert.deepEqual(settings.getMentionReactions(), ["robot_face"]);
  assert.deepEqual(settings.getMentionReactions("msteams"), ["hearteyesrobot", "alien", "like", "smilerobot"]);
  assert.deepEqual(settings.getMentionReactions("googlechat"), ["🤖"]);
});

test("settings API round-trips independent activation lists and partial changes", async () => {
  const saved = await put({ mentionReactions: ":ROCKET:, robot_face", teamsMentionReactions: [":ALIEN:", "👽", "alien"], googleChatMentionReactions: "🚀, 👨‍💻" });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.mentionReactions, ["rocket", "robot_face"]);
  assert.deepEqual(saved.body.teamsMentionReactions, ["alien", "👽"]);
  assert.deepEqual(saved.body.googleChatMentionReactions, ["🚀", "👨‍💻"]);
  const changed = await put({ teamsMentionReactions: "like" });
  assert.equal(changed.status, 200);
  assert.deepEqual(settings.getMentionReactions(), ["rocket", "robot_face"]);
  assert.deepEqual(settings.getMentionReactions("msteams"), ["like"]);
  assert.deepEqual(settings.getMentionReactions("googlechat"), ["🚀", "👨‍💻"]);
  const get = await fetch(`${base}/settings`);
  const payload = await get.json();
  for (const field of ["mentionReactions", "teamsMentionReactions", "googleChatMentionReactions"]) assert.deepEqual(payload[field], changed.body[field]);
});

test("invalid reaction input returns 400 atomically across all fields", async () => {
  const invalid = [null, {}, 5, ["alien", 7], ["x".repeat(101)], Array(21).fill("alien"), "<script>", "alien\n", "✅", ":octagonal_sign:", "2705_whiteheavycheckmark", "1f6d1_stopsign", "2705_tick", "stop", "ack", ":alien", ":alien::"];
  for (const value of invalid) {
    const before = settings.getSettingsVersion();
    const saved = await put({ sessionKeepalive: "99m", mentionReactions: "wave", teamsMentionReactions: value });
    assert.equal(saved.status, 400, JSON.stringify(value));
    assert.equal(settings.getSettingsVersion(), before);
    assert.deepEqual(settings.getMentionReactions(), ["rocket", "robot_face"]);
  }
  const invalidGoogle = await put({ teamsMentionReactions: "alien", googleChatMentionReactions: "rocket" });
  assert.equal(invalidGoogle.status, 400);
  assert.deepEqual(settings.getMentionReactions("msteams"), ["like"]);
});

test("empty fields reset only that platform and stale saves return all three lists", async () => {
  const before = settings.getSettingsVersion();
  const saved = await put({ teamsMentionReactions: [] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.teamsMentionReactions, ["hearteyesrobot", "alien", "like", "smilerobot"]);
  assert.deepEqual(saved.body.mentionReactions, ["rocket", "robot_face"]);
  const stale = await put({ googleChatMentionReactions: "👽", settingsVersion: before });
  assert.equal(stale.status, 409);
  for (const field of ["mentionReactions", "teamsMentionReactions", "googleChatMentionReactions"]) assert.deepEqual(stale.body[field], saved.body[field]);
});

test("hand-edited invalid activation configuration fails safely to platform defaults", () => {
  settings.saveSettings({ mentionReactions: ["robot_face"], teamsMentionReactions: ["✅"], googleChatMentionReactions: ["plain-name"] });
  assert.deepEqual(settings.getMentionReactions(), ["robot_face"]);
  assert.deepEqual(settings.getMentionReactions("msteams"), ["hearteyesrobot", "alien", "like", "smilerobot"]);
  assert.deepEqual(settings.getMentionReactions("googlechat"), ["🤖"]);
});


test("legacy Slack selections survive independent platform configuration upgrades", () => {
  settings.saveSettings({ mentionReactions: [":ROCKET:", "white_check_mark", "x"] });
  assert.deepEqual(settings.getMentionReactions(), ["rocket", "white_check_mark", "x"]);
  settings.saveSettings({ teamsMentionReactions: ["alien"], googleChatMentionReactions: ["🚀"] });
  assert.deepEqual(settings.getMentionReactions(), ["rocket", "white_check_mark", "x"]);
});

test("new Slack activation writes cannot override existing stop and acknowledgement controls", async () => {
  for (const reserved of ["x", "no_entry", "no_entry_sign", "raised_hand", "hand", "raised_back_of_hand", "palm_up_hand", "no_good", "white_check_mark"]) {
    const before = settings.getSettingsVersion();
    assert.equal((await put({ mentionReactions: reserved })).status, 400);
    assert.equal(settings.getSettingsVersion(), before);
  }
});

test("effective Teams changes record each A to B to A transition between Graph refreshes", async (t) => {
  t.mock.method(Date, "now", () => 1791374400000);
  assert.equal((await put({ teamsMentionReactions: "alien" })).status, 200);
  const a = settings.getTeamsMentionReactionsUpdatedAt();
  assert.equal((await put({ teamsMentionReactions: "rocket" })).status, 200);
  const b = settings.getTeamsMentionReactionsUpdatedAt();
  assert.equal((await put({ teamsMentionReactions: "alien" })).status, 200);
  const aAgain = settings.getTeamsMentionReactionsUpdatedAt();
  assert.ok(Date.parse(b) > Date.parse(a));
  assert.ok(Date.parse(aAgain) > Date.parse(b), "same millisecond changes still have distinct versions");
});

test("equivalent aliases, reordering and other surfaces do not advance Teams activation timestamp", async () => {
  assert.equal((await put({ teamsMentionReactions: "alien, like" })).status, 200);
  const before = settings.getTeamsMentionReactionsUpdatedAt();
  assert.equal((await put({ teamsMentionReactions: "👍, :ALIEN:, 👽", mentionReactions: "rocket", googleChatMentionReactions: "🚀" })).status, 200);
  assert.equal(settings.getTeamsMentionReactionsUpdatedAt(), before);
  assert.equal((await put({ sessionKeepalive: "16m", mentionReactions: "wave", googleChatMentionReactions: "👽" })).status, 200);
  assert.equal(settings.getTeamsMentionReactionsUpdatedAt(), before);
  assert.equal((await put({ teamsMentionReactionsUpdatedAt: "2099-01-01T00:00:00.000Z" })).status, 200);
  assert.equal(settings.getTeamsMentionReactionsUpdatedAt(), before, "API callers cannot forge the activation cutoff");
});

test("direct settings writes also stamp effective Teams changes and invalid timestamp reads fail safely", () => {
  const before = settings.getTeamsMentionReactionsUpdatedAt();
  settings.saveSettings({ teamsMentionReactions: ["🚀"] });
  assert.ok(Date.parse(settings.getTeamsMentionReactionsUpdatedAt()) > Date.parse(before));
  for (const invalid of [null, 123, "invalid", "2026-02-31T00:00:00.000Z", "2026-10-07"]) {
    settings.saveSettings({ teamsMentionReactionsUpdatedAt: invalid });
    assert.equal(settings.getTeamsMentionReactionsUpdatedAt(), "");
  }
});

test("Unicode activation entries each require one actual emoji grapheme", async () => {
  for (const invalid of ["\u200D", "\uFE0F", "🏻", "👽🤖", "🤖\u200D", "🇷"]) {
    for (const field of ["teamsMentionReactions", "googleChatMentionReactions"]) {
      const before = settings.getSettingsVersion();
      assert.equal((await put({ [field]: invalid })).status, 400, `${field}: ${JSON.stringify(invalid)}`);
      assert.equal(settings.getSettingsVersion(), before);
    }
  }
  for (const valid of ["👨‍💻", "👍🏾", "🇷🇴", "1️⃣", "❤️", "👽"]) {
    assert.deepEqual(settings.validateMentionReactions(valid, "googlechat"), [valid]);
  }
});
