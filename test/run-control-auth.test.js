import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const [{ authorizedControlEntry }, store] = await Promise.all([
  import("../src/slack/app.js"),
  import("../src/config/store.js"),
]);

// /stop, /status, and the 🛑 stop-reaction cancel or inspect OTHER users' runs, so they must be
// gated exactly like messages: admin/approved (or an explicit channel guest grant) only. An
// unauthorized workspace member must not be able to stop anyone's work or read run status.

async function registerChannel(channelId, slugName, metaPatch = {}) {
  await store.ensureRoot();
  const entry = await store.upsertChannelEntry(channelId, { name: slugName, type: "channel", isDM: false });
  await store.saveChannelMeta(entry.slug, {
    ...store.defaultChannelMeta({ channelId, name: slugName, type: "channel", isDM: false }),
    access: "approved",
    ...metaPatch,
  });
  return entry;
}

test("approved users and admins may control runs; unknown users may not", async () => {
  const entry = await registerChannel("C_CTRL", "ctrl");
  await store.setUser("U_CTRL_ADMIN", { name: "Admin", approved: true, isAdmin: true });
  await store.setUser("U_CTRL_OK", { name: "Approved", approved: true });
  await store.setUser("U_CTRL_NO", { name: "Unknown", approved: false, isAdmin: false });

  assert.equal((await authorizedControlEntry("C_CTRL", "U_CTRL_ADMIN"))?.slug, entry.slug);
  assert.equal((await authorizedControlEntry("C_CTRL", "U_CTRL_OK"))?.slug, entry.slug);
  assert.equal(await authorizedControlEntry("C_CTRL", "U_CTRL_NO"), null);
  assert.equal(await authorizedControlEntry("C_CTRL", "U_NEVER_SEEN"), null);
});

test("a channel guest grant admits an otherwise-unknown user to run controls", async () => {
  const entry = await registerChannel("C_CTRL_GUEST", "ctrl-guest", { allowedUsers: ["U_CTRL_GUEST"] });
  await store.setUser("U_CTRL_GUEST", { name: "Guest", approved: false, isAdmin: false });

  assert.equal((await authorizedControlEntry("C_CTRL_GUEST", "U_CTRL_GUEST"))?.slug, entry.slug);
});

test("an unregistered channel yields no control entry", async () => {
  assert.equal(await authorizedControlEntry("C_CTRL_NOWHERE", "U_CTRL_OK"), null);
});

test("/stop, /status, and the stop reaction all resolve through the authorization gate", () => {
  // Lock the wiring, not just the helper: each control surface must call authorizedControlEntry
  // instead of the ungated getChannelEntry.
  const src = readFileSync(new URL("../src/slack/app.js", import.meta.url), "utf8");

  const stopCmd = src.match(/app\.command\("\/stop",[\s\S]*?\n  \}\);/)?.[0] || "";
  const statusCmd = src.match(/app\.command\("\/status",[\s\S]*?\n  \}\);/)?.[0] || "";
  const stopReaction = src.match(/if \(STOP_REACTIONS\.has\(event\.reaction\)\) \{[\s\S]*?\n      \}/)?.[0] || "";

  for (const [label, handler] of [["/stop", stopCmd], ["/status", statusCmd], ["🛑 reaction", stopReaction]]) {
    assert.ok(handler.length > 0, `${label} handler found`);
    assert.match(handler, /authorizedControlEntry\(/, `${label} gates through authorizedControlEntry`);
    assert.doesNotMatch(handler, /await getChannelEntry\(/, `${label} does not use the ungated lookup`);
  }
});
