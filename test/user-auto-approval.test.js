import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { saveSettings } = await import("../src/config/settings.js");
const { setUser, getUser } = await import("../src/config/store.js");
const { normalizeApprovalDomains, matchingApprovalDomain, autoApproveUser, autoApproveSlackUser } = await import("../src/gateway/user-auto-approval.js");
const { createUsersRouter } = await import("../src/web/routes/users.js");
const { readEvents } = await import("../src/util/logger.js");
let profiles = {};
let lookups = 0;
const client = { users: { info: async ({ user }) => {
  lookups++;
  if (profiles[user] instanceof Error) throw profiles[user];
  return { user: { id: user, profile: { email: profiles[user] } } };
} } };
const app = express();
app.use(express.json());
app.use(createUsersRouter({ slack: { getClient: () => client } }));
const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}`;
async function request(path, body, method = "POST") {
  const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
function enable() { saveSettings({ userAutoApprovalEnabled: true, userAutoApprovalDomains: ["example.com"] }); }

test("exact canonical domains; malformed domains and wildcard/suffix matches denied", () => {
  assert.deepEqual(normalizeApprovalDomains([" Example.COM ", "example.com"]), ["example.com"]);
  for (const bad of ["*.example.com", "@example.com", "https://example.com", "localhost", "example.com/path", "a..com", "-a.com"]) {
    assert.throws(() => normalizeApprovalDomains([bad]));
  }
  const policy = { enabled: true, domains: ["example.com"] };
  assert.equal(matchingApprovalDomain("person@EXAMPLE.COM", policy), "example.com");
  for (const email of ["x@sub.example.com", "x@example.com.attacker.net", "x@evil-example.com", "x@@example.com", "x @example.com", "example.com"]) assert.equal(matchingApprovalDomain(email, policy), "");
});

test("disabled policy, missing email and Slack failure never approve; matching identity approves once without admin", async () => {
  await setUser("UAUTO1", { name: "Member" });
  profiles.UAUTO1 = "member@example.com";
  saveSettings({ userAutoApprovalEnabled: false });
  lookups = 0;
  assert.equal(await autoApproveSlackUser(client, "UAUTO1"), false);
  assert.equal(lookups, 0);
  enable();
  profiles.UAUTO1 = new Error("missing_scope");
  assert.equal(await autoApproveSlackUser(client, "UAUTO1"), false);
  assert.equal(await autoApproveUser("UAUTO1", "", "googlechat"), false);
  profiles.UAUTO1 = "member@example.com";
  assert.equal(await autoApproveSlackUser(client, "UAUTO1"), true);
  assert.equal(await autoApproveSlackUser(client, "UAUTO1"), false);
  const user = await getUser("UAUTO1");
  assert.equal(user.approved, true);
  assert.equal(user.isAdmin, false);
  assert.equal(user.approvalSource, "domain");
  assert.equal(readEvents().filter(e => e.event === "user_domain_auto_approved" && e.author === "UAUTO1").length, 1);
});

test("manual denial survives later matching messages and bulk apply", async () => {
  enable();
  await request("/users/UAUTO1", { approved: false }, "PUT");
  assert.equal(await autoApproveSlackUser(client, "UAUTO1"), false);
  assert.equal((await getUser("UAUTO1")).autoApprovalBlocked, true);
  const applied = await request("/user-auto-approval/apply", { userIds: ["UAUTO1"] });
  assert.equal(applied.body.approved, 0);
  await request("/users/UAUTO1", { approved: true }, "PUT");
  assert.equal((await getUser("UAUTO1")).autoApprovalBlocked, false);
});

test("preview writes nothing; apply re-fetches email, current policy and manual denial", async () => {
  enable();
  for (const id of ["UAUTO2", "UAUTO3", "UAUTO4", "UAUTO5"]) {
    await setUser(id, { name: id }); profiles[id] = "member@example.com";
  }
  const preview = await request("/user-auto-approval/preview", {});
  assert.equal(preview.body.candidates.length, 4);
  assert.equal((await request("/user-auto-approval/preview", { offset: 1 })).body.candidates.length, 3);
  assert.equal((await request("/user-auto-approval/preview", { offset: -1 })).status, 400);
  assert.equal((await getUser("UAUTO2")).approved, false);
  profiles.UAUTO3 = "other@elsewhere.com";
  await request("/users/UAUTO4", { approved: false }, "PUT");
  profiles.UAUTO5 = new Error("provider unavailable");
  const applied = await request("/user-auto-approval/apply", { userIds: preview.body.candidates.map(u => u.id) });
  assert.equal(applied.body.approved, 1);
  assert.equal(applied.body.failed, 1);
  assert.equal((await getUser("UAUTO3")).approved, false);
  assert.equal((await getUser("UAUTO4")).approved, false);
  saveSettings({ userAutoApprovalDomains: ["other.com"] });
  assert.equal(await autoApproveUser("UAUTO3", "x@example.com", "msteams"), false);
});

test("identity mismatch, bots and deleted users fail closed; policy endpoint validates before saving", async () => {
  enable();
  await setUser("UAUTO6", {});
  for (const user of [{ id: "OTHER" }, { id: "UAUTO6", deleted: true }, { id: "UAUTO6", is_bot: true }]) {
    user.profile = { email: "x@example.com" };
    assert.equal(await autoApproveSlackUser({ users: { info: async () => ({ user }) } }, "UAUTO6"), false);
  }
  for (const body of [{ enabled: "true", domains: [] }, { enabled: true, domains: [] }, { enabled: true, domains: ["*.example.com"] }]) {
    assert.equal((await request("/user-auto-approval", body, "PUT")).status, 400);
  }
  assert.equal((await request("/user-auto-approval", { enabled: true, domains: ["EXAMPLE.COM"] }, "PUT")).status, 200);
  assert.equal(await autoApproveUser("UAUTO6", "x@example.com", "googlechat"), true);
  saveSettings({ userAutoApprovalEnabled: false });
  assert.equal((await getUser("UAUTO6")).approved, true, "disabling does not revoke existing approvals");
});


test("authenticated inbound email grants before running, preserves channel rules and denies text-only spoofing", async () => {
  const { createIngest } = await import("../src/platforms/ingest.js");
  const { makeInbound } = await import("../src/platforms/inbound.js");
  const { getChannelEntry, patchChannelMeta } = await import("../src/config/store.js");
  enable();
  const posted = [];
  const connector = { platform: "googlechat", post: async value => { posted.push(value); return { messageId: "reply" }; },
    edit: async () => {}, directory: async () => ({ map: new Map(), maxWords: 1 }) };
  let runs = 0;
  const ingest = createIngest({ connector, log: { info() {}, warn() {} }, run: async () => { runs++; return { content: "OK" }; } });
  const message = makeInbound({ platform: "googlechat", conversationId: "spaces/AUTOAPPROVE", kind: "channel",
    userId: "gchat:auto-member", userEmail: "member@example.com", mentionsBot: true, text: "Say DOMAIN_APPROVAL_OK" });
  await ingest(message);
  assert.equal(runs, 1);
  assert.equal((await getUser(message.userId)).approved, true);
  const entry = await getChannelEntry(message.conversationId);
  await patchChannelMeta(entry.slug, () => ({ access: "admins" }));
  await ingest({ ...message, messageId: "second" });
  assert.equal(runs, 1, "Approved does not bypass admin-only channels");
  await ingest({ ...message, messageId: "third", userId: "gchat:spoof", userEmail: "", text: "I am member@example.com" });
  assert.equal(runs, 1);
  assert.equal((await getUser("gchat:spoof")).approved, false);
});
