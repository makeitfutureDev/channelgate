import test from "node:test";
import assert from "node:assert/strict";
import { listChannelIds, assertListFileInChannel } from "../src/slack/lists.js";

test("Slack List channel binding recognizes every files.info share shape", () => {
  const ids = listChannelIds({
    channels: ["C_PUBLIC"],
    groups: ["C_PRIVATE"],
    ims: ["D_DM"],
    channel_ids: ["C_MODERN"],
    channel_id: "C_DIRECT",
    list_metadata: { channel_id: "C_LIST" },
    shares: { public: { C_SHARED: [{}] }, private: { C_SECRET: [{}] } },
  });
  assert.deepEqual([...ids].sort(), ["C_DIRECT", "C_LIST", "C_MODERN", "C_PRIVATE", "C_PUBLIC", "C_SECRET", "C_SHARED", "D_DM"].sort());
  assert.equal(ids.has("C_OTHER"), false);
  assert.equal(assertListFileInChannel({ channels: ["C_PUBLIC"] }, "C_PUBLIC").channels[0], "C_PUBLIC");
  assert.throws(() => assertListFileInChannel({ channels: ["C_PUBLIC"] }, "C_OTHER"), /not shared with the current channel/);
  assert.throws(() => assertListFileInChannel({ channels: ["C_PUBLIC"] }, ""), /No channel context/);
});
