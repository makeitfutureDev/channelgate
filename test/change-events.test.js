// Configuration writes announce themselves in-process (src/config/change-events.js) so a prepared
// long-lived copy of that state — an SSH session's files — can follow at once. Live finding
// (0.5.3): a secret added to a channel did not reach an open SSH session until the 20-minute tick.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
const { onConfigChange, emitConfigChange } = await import("../src/config/change-events.js");
const store = await import("../src/config/store.js");
const scoped = await import("../src/config/scoped-env.js");

test.after(() => rmSync(scratch, { recursive: true, force: true }));

const seen = [];
const off = onConfigChange((change) => seen.push(change));
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

test("every write chokepoint emits after it commits, naming what changed and never a value", async () => {
  await store.saveChannelMeta("evt-chan", { ...store.defaultChannelMeta({ channelId: "C_EVT", name: "evt", type: "channel", isDM: false }) });
  await store.patchChannelMeta("evt-chan", { allowNetwork: true });
  await store.patchChannelMeta("evt-chan", () => null);
  await store.setUser("U_EVT", { name: "Evt", approved: true });
  scoped.patchOrgEnv({ set: { name: "EVT_ORG_SECRET", value: "org-value-1234567890" }, actor: "U_EVT" });
  await scoped.patchUserEnv("U_EVT", { set: { name: "EVT_MY_SECRET", value: "my-value-1234567890" } });
  await flush();
  assert.deepEqual(seen, [
    { kind: "channel-meta", slug: "evt-chan" },
    { kind: "channel-meta", slug: "evt-chan" },
    { kind: "user", userId: "U_EVT" },
    { kind: "org-env" },
    { kind: "user", userId: "U_EVT" },
  ], "an aborted patch (null) emits nothing; a personal secret is a user write");
  assert.ok(!JSON.stringify(seen).includes("value-1234567890"));
});

test("a throwing listener never fails the write, and an unknown kind is refused", async () => {
  const bad = onConfigChange(() => { throw new Error("listener bug"); });
  await store.patchChannelMeta("evt-chan", { allowNetwork: false });
  await flush();
  bad();
  assert.equal(seen.at(-1).slug, "evt-chan");
  assert.throws(() => emitConfigChange("nope", {}), /unknown config change kind/);
  off();
  await store.patchChannelMeta("evt-chan", { allowNetwork: true });
  await flush();
  assert.equal(seen.filter((e) => e.kind === "channel-meta").length, 3, "unsubscribed");
});
