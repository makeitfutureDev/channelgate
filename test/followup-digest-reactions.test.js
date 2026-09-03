import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/slack/app.js", import.meta.url), "utf8");

test("digest dismissal is routed after reminder acknowledgments and before direct-thread reactions", () => {
  assert.match(source, /applyDigestDoneReaction/);
  const ack = source.indexOf("const ack = findAckByMessage(channelId, event.item?.ts)");
  const digest = source.indexOf("applyDigestDoneReaction(event.user, channelId, event.item.ts)");
  const directLookup = source.indexOf("client.reactions.get(", digest);
  const directDone = source.indexOf("markDone(event.user, channelId, threadTs)", directLookup);

  assert.ok(
    ack >= 0 && digest > ack && directLookup > digest && directDone > directLookup,
    "reminder ack → digest snapshot → direct source thread must remain the reaction-added order",
  );
});

test("digest reaction removal is routed before direct-thread reopening", () => {
  assert.match(source, /removeDigestDoneReaction/);
  const removedHandler = source.indexOf('app.event("reaction_removed"');
  const digest = source.indexOf("removeDigestDoneReaction(event.user, channelId, event.item.ts)", removedHandler);
  const directLookup = source.indexOf("client.reactions.get(", digest);
  const directClear = source.indexOf("clearDone(event.user, channelId, threadTs)", directLookup);

  assert.ok(
    removedHandler >= 0 && digest > removedHandler && directLookup > digest && directClear > directLookup,
    "digest snapshot removal must be consumed before the direct source-thread fallback",
  );
});
