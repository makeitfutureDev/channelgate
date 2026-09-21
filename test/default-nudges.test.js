// Organization default + bulk reset for personal quiet-thread reminders. The preference belongs
// to a user record, never channel metadata, and bulk changes preserve every unrelated user field.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { getUser, setUser } = await import("../src/config/store.js");
const { getDefaultNudges, saveSettings, userNudgesEnabled } = await import("../src/config/settings.js");
const { createUsersRouter } = await import("../src/web/routes/users.js");

const app = express();
app.use(express.json());
app.use(createUsersRouter());
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

test("user reminder preference defaults off and follows an explicit personal override", async () => {
  assert.equal(getDefaultNudges(), false);
  assert.equal(userNudgesEnabled(await getUser("U_MISSING")), false);

  saveSettings({ defaultNudges: true });
  assert.equal(getDefaultNudges(), true);
  assert.equal(userNudgesEnabled(null), false, "a missing/deleted user fails closed");
  assert.equal(userNudgesEnabled({ name: "legacy row" }), true, "legacy rows inherit the current default until backfilled");
  assert.equal(userNudgesEnabled({ nudges: false }), false, "a user's own choice wins");

  saveSettings({ defaultNudges: false });
  assert.equal(userNudgesEnabled({ nudges: true }), true);
});

test("bulk reset applies the default to users without changing their other fields", async () => {
  await setUser("U_KEEP", {
    name: "Keep",
    approved: true,
    isAdmin: true,
    skills: ["x"],
    composioToken: "secret-kept",
    nudges: false,
  });
  await setUser("U_OTHER", { name: "Other", approved: false, nudges: false });
  saveSettings({ defaultNudges: true });

  const response = await fetch(`${base}/users/reset-nudges`, { method: "POST" });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.nudges, true);
  assert.equal(result.count, 2);

  const kept = await getUser("U_KEEP");
  assert.equal(kept.nudges, true);
  assert.equal(kept.name, "Keep");
  assert.equal(kept.approved, true);
  assert.equal(kept.isAdmin, true);
  assert.deepEqual(kept.skills, ["x"]);
  assert.equal(kept.composioToken, "secret-kept");
  assert.equal((await getUser("U_OTHER")).nudges, true);
});

test("the user API exposes and saves the personal reminder choice", async () => {
  const save = await fetch(`${base}/users/U_KEEP`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nudges: false }),
  });
  assert.equal(save.status, 200);
  assert.equal((await save.json()).user.nudges, false);

  const list = await fetch(`${base}/users`);
  const users = (await list.json()).users;
  assert.equal(users.U_KEEP.nudges, false);
  assert.equal(users.U_KEEP.composioToken, undefined, "the new preference does not weaken secret masking");
});
