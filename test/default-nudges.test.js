// Org-default no-response nudge: getDefaultNudges reads the settings flag, and the "reset all"
// route's patch (patchChannelMeta with a defaultChannelMeta fallback) preserves every other field
// on an existing channel while writing a FULL default record — never a nudges-only partial — for a
// channel that has no meta row yet. Scratch gateway dir + SQLite (env set before the store import).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { saveChannelMeta, getChannelMeta, patchChannelMeta, defaultChannelMeta } = await import("../src/config/store.js");
const { getDefaultNudges, saveSettings } = await import("../src/config/settings.js");

// Mirror of the reset-nudges route body for one channel.
const resetOne = (ch, nudges) =>
  patchChannelMeta(ch.slug, (current) => {
    const base = current ?? defaultChannelMeta({ channelId: ch.channelId, name: ch.name, type: ch.type, isDM: ch.isDM });
    return { ...base, nudges };
  });

test("getDefaultNudges defaults off and follows the saved flag", () => {
  assert.equal(getDefaultNudges(), false); // unset → off (nudges stay opt-in)
  saveSettings({ defaultNudges: true });
  assert.equal(getDefaultNudges(), true);
  saveSettings({ defaultNudges: false });
  assert.equal(getDefaultNudges(), false);
});

test("reset flips nudges but keeps every other field", async () => {
  await saveChannelMeta("keep", { adminMode: true, allowBash: true, skills: ["x"], nudges: false });
  const next = await resetOne({ slug: "keep", channelId: "C1", name: "keep", type: "channel", isDM: false }, true);
  assert.equal(next.nudges, true);
  assert.equal(next.adminMode, true); // untouched
  assert.equal(next.allowBash, true);
  assert.deepEqual(next.skills, ["x"]);
});

test("reset on a channel with no meta row writes a full default record, not a nudges-only partial", async () => {
  const next = await resetOne({ slug: "fresh", channelId: "C9", name: "fresh", type: "channel", isDM: false }, true);
  assert.equal(next.nudges, true);
  // A full record has the rest of the default shape — a partial {nudges} would be missing these.
  assert.equal(next.channelId, "C9");
  assert.equal(next.access, "approved");
  assert.deepEqual(next.allowedUsers, []);
  assert.equal(next.adminMode, false);
  const stored = await getChannelMeta("fresh"); // survives the JSON round-trip with the full shape
  assert.equal(stored.nudges, true);
  assert.equal(stored.access, "approved");
  assert.equal(stored.channelId, "C9");
  assert.equal(stored.adminMode, false);
});
