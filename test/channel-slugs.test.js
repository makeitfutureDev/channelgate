import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { upsertChannelEntry } = await import("../src/config/store.js");

test("same-name channels allocate stable unique slugs under the database write lock", async () => {
  const [first, second] = await Promise.all([
    upsertChannelEntry("C_SLUG_ONE", { name: "Collision Room", type: "channel" }),
    upsertChannelEntry("C_SLUG_TWO", { name: "Collision Room", type: "channel" }),
  ]);
  assert.equal(first.slug, "collision-room");
  assert.equal(second.slug, "collision-room-c_slug_two");
  assert.notEqual(first.slug, second.slug);

  const renamed = await upsertChannelEntry("C_SLUG_TWO", { name: "A New Display Name" });
  assert.equal(renamed.slug, second.slug, "a channel's allocated slug remains stable");
});
