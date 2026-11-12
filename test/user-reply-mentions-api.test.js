import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { getUser, setUser } = await import("../src/config/store.js");
const { createUsersRouter } = await import("../src/web/routes/users.js");
const app = express();
app.use(express.json());
app.use(createUsersRouter());
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.closeAllConnections(); server.close(); });
const save = (body) => fetch(`${base}/users/U_PREFERENCE`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("the masked user API exposes reply mentions and saves both choices without losing other fields", async () => {
  await setUser("U_PREFERENCE", { name: "Preference", approved: true, nudges: true, composioToken: "fixture-secret", replyMentions: false });
  const initial = await getUser("U_PREFERENCE");
  for (const replyMentions of [true, false]) {
    const response = await save({ replyMentions });
    assert.equal(response.status, 200);
    const saved = (await response.json()).user;
    assert.equal(saved.replyMentions, replyMentions);
    assert.equal(saved.composioToken, undefined);
    assert.deepEqual(await getUser("U_PREFERENCE"), { ...initial, replyMentions });
    const users = (await (await fetch(`${base}/users`)).json()).users;
    assert.equal(users.U_PREFERENCE.replyMentions, replyMentions);
    assert.equal(users.U_PREFERENCE.composioToken, undefined);
  }
  assert.equal((await (await save({ name: "Renamed" })).json()).user.replyMentions, false, "omitting the preference preserves the choice");
});

test("non-boolean mention preferences reject the entire update", async () => {
  const before = await getUser("U_PREFERENCE");
  for (const value of ["true", "false", 1, 0, null, {}, []]) {
    const response = await save({ name: "Must not change", replyMentions: value });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /replyMentions must be a boolean/);
    assert.deepEqual(await getUser("U_PREFERENCE"), before);
  }
});
