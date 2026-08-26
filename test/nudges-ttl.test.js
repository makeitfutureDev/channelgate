// Low: the nudge map's reminded-thread entries never expired. pruneExpired sweeps them by TTL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv(); // nudges.js imports the store chain — keep any DB access on the scratch file

const { pruneExpired } = await import("../src/gateway/nudges.js");

const DAY = 24 * 60 * 60 * 1000;
const rec = (lastBotTs, extra = {}) => ({ channelId: "C1", slug: "s", threadKey: "t", lastBotTs, awaitingUser: true, reminded: false, ...extra });

test("expired entries are dropped, fresh ones kept", () => {
  const now = 100 * DAY;
  const map = new Map([
    ["s::old", rec(now - 8 * DAY, { reminded: true })], // reminded long ago — dead weight
    ["s::stale", rec(now - 7 * DAY - 1)], // just past the 7d TTL
    ["s::fresh", rec(now - 1 * DAY)],
    ["s::edge", rec(now - 7 * DAY)], // exactly at TTL — kept (strict >)
  ]);
  pruneExpired(map, now);
  assert.deepEqual([...map.keys()].sort(), ["s::edge", "s::fresh"]);
});

test("entries without a timestamp count as expired", () => {
  const now = 100 * DAY;
  const map = new Map([["s::broken", rec(undefined)]]);
  pruneExpired(map, now);
  assert.equal(map.size, 0);
});

test("a custom ttl is honored", () => {
  const now = 10_000;
  const map = new Map([
    ["a", rec(now - 5_001)],
    ["b", rec(now - 4_999)],
  ]);
  pruneExpired(map, now, 5_000);
  assert.deepEqual([...map.keys()], ["b"]);
});
