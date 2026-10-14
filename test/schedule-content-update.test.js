import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { register } = await import("../src/mcp/tools/schedules.js");
const { addSchedule, listForChannel, updateSchedule } = await import("../src/config/schedules.js");

function tools({ channelId = "C_CONTENT", createdBy = "U_OWNER", requireAdmin = async () => false } = {}) {
  const registry = new Map();
  register({ registerTool: (name, spec, handler) => registry.set(name, { spec, handler }) }, {
    channelId, slug: "content", createdBy, requireAdmin, text: (text) => text,
  });
  return async (name, args = {}) => {
    const { spec, handler } = registry.get(name);
    return handler(z.object(spec.inputSchema).parse(args));
  };
}
function fixture(extra = {}) {
  return addSchedule({ channelId: "C_CONTENT", slug: "content", createdBy: "U_OWNER", cron: "0 9 * * *", prompt: "Use personal-email for the personal mailbox. Preserve labels. Report briefly.", description: "Daily email", notify: "none", delivery: "daily-thread", ...extra });
}
const stored = (s) => listForChannel(s.channelId).find((row) => row.id === s.id);

test("read full prompt then edit the same job without changing identity, cadence, delivery or history", async () => {
  const call = tools();
  const s = fixture();
  updateSchedule(s.id, { lastRun: "2026-10-12T09:00:00Z", lastStatus: "ok", dailyThreadDate: "2026-10-12", dailyThreadTs: "1791795600.1", enabled: false });
  const before = stored(s);
  const details = JSON.parse(await call("list_schedules", { id: s.id }));
  assert.equal(details.prompt, before.prompt);
  assert.equal(details.createdBy, "U_OWNER");
  assert.equal(details.enabled, false);
  const revised = `${details.prompt}\nAlso review spam; move important messages to inbox and move the rest to trash.`;
  assert.match(await call("update_schedule", { id: s.id, expected_prompt: details.prompt, prompt: revised, description: "Daily email and spam" }), /saved for future fires/);
  assert.deepEqual(stored(s), { ...before, prompt: revised, description: "Daily email and spam" });
  assert.equal(JSON.parse(await call("list_schedules", { id: s.id })).prompt, revised);
});

test("stale, missing and empty prompts reject the whole patch", async () => {
  const call = tools();
  const s = fixture();
  for (const args of [
    { prompt: "New prompt" },
    { prompt: "New prompt", expected_prompt: "stale" },
    { prompt: " \n", expected_prompt: s.prompt },
    { description: "Changed title" },
  ]) {
    const reply = await call("update_schedule", { id: s.id, execution_visibility: "silent", ...args });
    assert.doesNotMatch(reply, /^Updated/);
    assert.deepEqual(stored(s), s);
  }
  updateSchedule(s.id, { prompt: "A concurrent edit" });
  assert.match(await call("update_schedule", { id: s.id, expected_prompt: s.prompt, prompt: "Old edit" }), /changed or was deleted/);
  assert.equal(stored(s).prompt, "A concurrent edit");
});

test("content edits enforce channel scope and creator/admin authority", async () => {
  const s = fixture();
  const args = { id: s.id, expected_prompt: s.prompt, prompt: "Updated by admin" };
  assert.match(await tools({ channelId: "C_OTHER" })("list_schedules", { id: s.id }), /No schedule/);
  assert.match(await tools({ channelId: "C_OTHER", requireAdmin: async () => true })("update_schedule", args), /No schedule/);
  for (const createdBy of ["U_OTHER", ""]) {
    assert.match(await tools({ createdBy })("update_schedule", args), /Only the schedule creator/);
    assert.deepEqual(stored(s), s);
  }
  assert.match(await tools({ createdBy: "U_ADMIN", requireAdmin: async () => true })("update_schedule", args), /^Updated/);
  assert.equal(stored(s).createdBy, "U_OWNER");
});

test("owner changes during the async admin check cannot authorize a stale edit", async () => {
  const s = fixture();
  const call = tools({ createdBy: "U_OTHER", requireAdmin: async () => { updateSchedule(s.id, { createdBy: "U_NEW_OWNER" }); return true; } });
  assert.match(await call("update_schedule", { id: s.id, expected_prompt: s.prompt, prompt: "Stale edit" }), /changed or was deleted/);
  assert.equal(stored(s).prompt, s.prompt);
  assert.equal(stored(s).createdBy, "U_NEW_OWNER");
});

test("guarded store edits reject stale scope or content and preserve concurrent run state", () => {
  const s = fixture();
  updateSchedule(s.id, { lastStatus: "running", activeRunId: "run-existing" });
  const expected = { channelId: s.channelId, prompt: s.prompt, createdBy: s.createdBy };
  assert.equal(updateSchedule(s.id, { prompt: "No" }, { ...expected, channelId: "C_OTHER" }), null);
  assert.equal(updateSchedule(s.id, { prompt: "No" }, { ...expected, prompt: "stale" }), null);
  const updated = updateSchedule(s.id, { prompt: "New" }, expected);
  assert.equal(updated.lastStatus, "running");
  assert.equal(updated.activeRunId, "run-existing");
  assert.equal(updateSchedule("missing", { prompt: "No" }, expected), null);
});

test("an async configuration race refuses the whole edit, including delivery options", async () => {
  const s = fixture();
  const call = tools({ createdBy: "U_ADMIN", requireAdmin: async () => {
    updateSchedule(s.id, { description: "Concurrent title edit" });
    return true;
  } });
  assert.match(await call("update_schedule", { id: s.id, expected_prompt: s.prompt, prompt: "New", execution_visibility: "silent" }), /changed or was deleted/);
  assert.deepEqual(stored(s), { ...s, description: "Concurrent title edit" });
});

test("ordinary options retain their existing behavior and loop prompts cannot be edited", async () => {
  const s = fixture();
  assert.match(await tools({ createdBy: "U_OTHER" })("update_schedule", { id: s.id, execution_visibility: "silent" }), /^Updated/);
  assert.equal(stored(s).executionVisibility, "silent");
  const loop = fixture({ loop: true });
  assert.match(await tools()("update_schedule", { id: loop.id, expected_prompt: loop.prompt, prompt: "No" }), /loop controls/);
  assert.equal(stored(loop).prompt, loop.prompt);
});
