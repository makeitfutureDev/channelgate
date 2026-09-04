import test from "node:test";
import assert from "node:assert/strict";

import { canOpenMessageFileButton, fileButtonNoticePayload } from "../src/slack/app.js";

test("message file buttons allow their owner and admins, but not another ordinary user", () => {
  assert.equal(canOpenMessageFileButton({ ownerId: "U_OWNER", clickerId: "U_OWNER" }), true);
  assert.equal(canOpenMessageFileButton({ ownerId: "U_OWNER", clickerId: "U_ADMIN", clickerIsAdmin: true }), true);
  assert.equal(canOpenMessageFileButton({ ownerId: "U_OWNER", clickerId: "U_OTHER" }), false);
  assert.equal(canOpenMessageFileButton({ ownerId: "U_OWNER", clickerId: "", clickerIsAdmin: true }), false);
});

test("file-button notices stay in the thread encoded by the clicked button", () => {
  assert.deepEqual(fileButtonNoticePayload(
    { channel: { id: "C1" }, message: { ts: "reply.2", thread_ts: "root.1" } },
    { c: "C1", t: "root.1" },
    "U_ADMIN",
    "This file explorer button isn't for you.",
  ), {
    channel: "C1",
    user: "U_ADMIN",
    thread_ts: "root.1",
    text: "This file explorer button isn't for you.",
  });
});

test("file-button notices recover the source thread from Slack when older controls omit it", () => {
  assert.equal(fileButtonNoticePayload(
    { channel: { id: "C1" }, message: { ts: "reply.2", thread_ts: "root.1" } },
    { c: "C1" },
    "U1",
    "Expired.",
  ).thread_ts, "root.1");
});
