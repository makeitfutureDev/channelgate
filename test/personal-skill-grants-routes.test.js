// A personal skill belongs to its author's own tier. The admin UI's reference list separates
// personal skills (with their author) from the shared list, and every save path refuses to newly
// grant someone else's personal skill — the Callbox incident where an admin ticked another
// person's personal skills for a user, after which every one of that user's runs failed.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const catalog = await import("../src/gateway/skills/catalog.js");
const { setUser, getUser } = await import("../src/config/store.js");
const { createUsersRouter } = await import("../src/web/routes/users.js");
const { createSkillsRouter } = await import("../src/web/routes/skills.js");

const md = (name) => ({ path: "SKILL.md", content: `---\nname: ${name}\ndescription: ${name} workflow\n---\nBody\n` });

async function serve(t, router) {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  const server = await new Promise((resolve) => { const value = app.listen(0, "127.0.0.1", () => resolve(value)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return (path, init = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    ...init, headers: { "Content-Type": "application/json", "X-CG-Request": "1", ...(init.headers || {}) },
  });
}

test("the Users save refuses another person's personal skill and keeps the author's own", async (t) => {
  catalog.putSkillRevision({ files: [md("Owner Private")], ownerKind: "local", createdBy: "U_OWNER", visibility: "personal" });
  catalog.putSkillRevision({ files: [md("Shared Route Skill")], ownerKind: "local" });
  await setUser("U_OTHER", { name: "Other", approved: true, skills: [] });
  await setUser("U_OWNER", { name: "Owner", approved: true, skills: [] });
  const call = await serve(t, createUsersRouter({ validateMcpSelections: async () => {} }));
  const put = (id, skills) => call(`/api/users/${id}`, { method: "PUT", body: JSON.stringify({ accessGrants: { skills, allowedMcps: [] } }) });

  const refused = await put("U_OTHER", ["owner-private", "shared-route-skill"]);
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /"owner-private" is another person's personal skill/);
  assert.deepEqual((await getUser("U_OTHER")).skills, [], "a refused save changes nothing");

  assert.equal((await put("U_OTHER", ["shared-route-skill"])).status, 200);
  assert.equal((await put("U_OWNER", ["owner-private"])).status, 200, "the author may hold their own personal skill");
  assert.deepEqual((await getUser("U_OWNER")).skills, ["owner-private"]);

  // A grant stored before this check never blocks an unrelated save; unticking it removes it.
  await setUser("U_OTHER", { skills: ["owner-private", "shared-route-skill"] });
  assert.equal((await put("U_OTHER", ["owner-private", "shared-route-skill"])).status, 200);
  assert.equal((await put("U_OTHER", ["shared-route-skill"])).status, 200);
  assert.deepEqual((await getUser("U_OTHER")).skills, ["shared-route-skill"]);
});

test("skill templates refuse personal skills", async (t) => {
  catalog.putSkillRevision({ files: [md("Template Private")], ownerKind: "local", createdBy: "U_OWNER", visibility: "personal" });
  const call = await serve(t, createSkillsRouter());
  const res = await call("/api/skills/templates", { method: "POST", body: JSON.stringify({ slug: "personal-route-template", name: "T", skills: ["template-private"] }) });
  // The template route is an Enterprise feature; without the entitlement it refuses before the
  // personal check, which is equally a refusal.
  assert.ok([400, 402, 403].includes(res.status), `expected a refusal, got ${res.status}`);
  assert.equal(catalog.getTemplate("personal-route-template"), null);
});
