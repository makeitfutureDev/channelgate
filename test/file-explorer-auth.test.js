import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const [{ fileExplorerContext }, store] = await Promise.all([
  import("../src/slack/app.js"),
  import("../src/config/store.js"),
]);

async function registerChannel(channelId = "C_FILES", slugName = "files") {
  await store.ensureRoot();
  const entry = await store.upsertChannelEntry(channelId, { name: slugName, type: "channel", isDM: false });
  await store.saveChannelMeta(entry.slug, {
    ...store.defaultChannelMeta({ channelId, name: slugName, type: "channel", isDM: false }),
    access: "approved",
  });
  return entry;
}

test("file explorer passes the resolved approved-user flag into authorization", async () => {
  const entry = await registerChannel();
  await store.setUser("U_APPROVED", { name: "Approved", approved: true });

  const context = await fileExplorerContext({}, { channelId: "C_FILES", userId: "U_APPROVED" });

  assert.equal(context.entry.slug, entry.slug);
  assert.equal(context.meta.access, "approved");
  assert.ok(context.root);
});

test("file explorer still refuses an unapproved user", async () => {
  await registerChannel("C_PRIVATE", "private-files");
  await store.setUser("U_UNKNOWN", { name: "Unknown", approved: false, isAdmin: false });

  await assert.rejects(
    () => fileExplorerContext({}, { channelId: "C_PRIVATE", userId: "U_UNKNOWN" }),
    /not authorized to browse files/i,
  );
});
