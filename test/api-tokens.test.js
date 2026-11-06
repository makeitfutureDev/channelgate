// Channel-level user API tokens (src/gateway/api-tokens.js): the store, the /api/runs gate, the
// principal a run receives, job visibility, the MCP tools and the admin listing. Hermetic: only
// refused or driver-injected runs, so no engine is ever spawned.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();
process.env.ADMIN_PASSWORD = "test-admin-pw";
process.env.CG_API_KEY = "cg_legacykey_abcdef0123456789";
process.env.CG_APPROVAL_SECRET = "internal-test-secret";
process.env.CG_WORKSPACE_DIR = path.join(scratch, "api-token-workspaces");
const LEGACY = process.env.CG_API_KEY;

const store = await import("../src/config/store.js");
const tokens = await import("../src/gateway/api-tokens.js");
const { startApiRun } = await import("../src/gateway/api-runs.js");
const { createWebApp } = await import("../src/web/app.js");
const { createApiTokensRouter } = await import("../src/web/routes/api-tokens.js");
const { ctxFromClaims } = await import("../src/mcp/gateway-server.js");
const { register: registerApiTokenTools } = await import("../src/mcp/tools/api-tokens.js");

await store.ensureRoot();
async function channel(id, name, patch = {}) {
  const entry = await store.upsertChannelEntry(id, { name, type: "channel", isDM: false });
  await store.saveChannelMeta(entry.slug, { ...store.defaultChannelMeta({ channelId: id, name, type: "channel", isDM: false }), access: "approved", manageAccess: "admins", platform: "slack", ...patch });
  return entry;
}
const MAIN_ID = "C_TOK_MAIN";
const OTHER_ID = "C_TOK_OTHER";
const main = { ...(await channel(MAIN_ID, "tok-main")), channelId: MAIN_ID };
const other = { ...(await channel(OTHER_ID, "tok-other")), channelId: OTHER_ID };
await store.setUser("U_TOK_ADMIN", { name: "Admin", approved: true, isAdmin: true });
await store.setUser("U_TOK_MEMBER", { name: "Member", approved: true, isAdmin: false });
await store.setUser("U_TOK_NOBODY", { name: "Nobody", approved: false, isAdmin: false });

const slackStub = { snapshot: () => ({ status: "disconnected", connected: false }), getClient: () => null };
const app = createWebApp({ slack: slackStub });
const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());
const post = (p, body, headers = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body ?? {}) });
const get = (p, headers = {}) => fetch(base + p, { headers });

test("store: a token is minted once, resolved by hash, listed without its value, and dies on revoke", () => {
  const { token, record } = tokens.createApiToken({ name: "make flow", channelId: main.channelId, slug: main.slug, createdBy: "U_TOK_MEMBER" });
  assert.match(token, /^cgk_[A-Za-z0-9_-]{32}$/);
  assert.equal(record.prefix, token.slice(0, 8));
  assert.equal(record.last4, token.slice(-4));
  assert.equal(record.lastUsedAt, "");
  const resolved = tokens.resolveApiToken(token);
  assert.equal(resolved.id, record.id);
  assert.equal(resolved.createdBy, "U_TOK_MEMBER");
  assert.ok(tokens.getApiToken(record.id).lastUsedAt, "use is recorded");
  const tampered = `${token.slice(0, -1)}${token.endsWith("x") ? "y" : "x"}`;
  assert.equal(tokens.resolveApiToken(tampered), null);
  assert.equal(tokens.resolveApiToken("cg_not_a_channel_token"), null);
  assert.doesNotMatch(JSON.stringify(tokens.listApiTokens({ channelId: main.channelId })), new RegExp(token.slice(8, 30)));
  tokens.revokeApiToken(record.id);
  assert.equal(tokens.resolveApiToken(token), null);
  assert.throws(() => tokens.revokeApiToken(record.id), /already revoked/);
  assert.throws(() => tokens.createApiToken({ name: "", channelId: main.channelId, slug: main.slug, createdBy: "U" }), /needs a name/);
});

test("/api/runs: a channel token authenticates, binds to its conversation, and follows its creator's live access", async () => {
  const admin = tokens.createApiToken({ name: "admin", channelId: main.channelId, slug: main.slug, createdBy: "U_TOK_ADMIN" });
  const nobody = tokens.createApiToken({ name: "nobody", channelId: main.channelId, slug: main.slug, createdBy: "U_TOK_NOBODY" });
  // Authentication passes: the request fails on validation (no message), before any run.
  let r = await post("/api/runs", {}, { "x-api-key": admin.token });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /message/i);
  r = await post("/api/runs", {}, { authorization: `Bearer ${admin.token}` });
  assert.equal(r.status, 400);
  // Bound to its conversation: naming another one is refused before anything starts.
  r = await post("/api/runs", { message: "hi", channel: other.channelId }, { "x-api-key": admin.token });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /belongs to conversation tok-main/);
  // The creator's authorization is read live: an un-approved owner's token is useless.
  r = await post("/api/runs", { message: "hi" }, { "x-api-key": nobody.token });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /no longer authorized/);
  // Revoked → 401 like a wrong key. The legacy key still passes the gate.
  tokens.revokeApiToken(admin.record.id);
  r = await post("/api/runs", {}, { "x-api-key": admin.token });
  assert.equal(r.status, 401);
  r = await post("/api/runs", {}, { "x-api-key": LEGACY });
  assert.equal(r.status, 400);
  r = await post("/api/runs", {}, { "x-api-key": "cgk_unknownunknownunknownunknownun" });
  assert.equal(r.status, 401);
});

test("the run acts as the token's creator (trusted), while the legacy key keeps the API principal", async () => {
  const seen = [];
  const driver = async (job, opts) => { seen.push({ job, opts }); };
  const principal = { channelId: main.channelId, slug: main.slug, createdBy: "U_TOK_ADMIN", tokenId: 1 };
  const started = await startApiRun({ message: "who am I", principal, driver, slack: null });
  assert.equal(started.ok, true, started.error);
  assert.equal(started.slug, main.slug);
  const byToken = seen.at(-1).job;
  assert.equal(byToken.author, "U_TOK_ADMIN");
  assert.equal(byToken.principalKind, "user");
  assert.equal(byToken.apiTokenId, 1);
  // `author` in the body is ignored for a channel token.
  const spoof = await startApiRun({ message: "who am I", author: "U_SOMEONE_ELSE", principal: { ...principal, createdBy: "U_TOK_MEMBER" }, driver, slack: null });
  assert.equal(spoof.ok, true, spoof.error);
  assert.equal(seen.at(-1).job.author, "U_TOK_MEMBER");
  // Legacy key / no principal: the fixed API principal, attribution only.
  const legacy = await startApiRun({ message: "who am I", author: "U_TOK_MEMBER", channel: main.channelId, driver, slack: null });
  assert.equal(legacy.ok, true, legacy.error);
  assert.equal(seen.at(-1).job.principalKind, "api");
  assert.equal(seen.at(-1).job.author, "U_TOK_MEMBER", "attribution label only");
  // A revoked-looking creator (un-approved) is refused even with a direct principal.
  const refused = await startApiRun({ message: "x", principal: { ...principal, createdBy: "U_TOK_NOBODY" }, driver, slack: null });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 403);
});

test("the driver maps the principal kind onto runMessage's trust flags", async () => {
  // Source-level pin of the two lines that decide who the run IS — the behavioural half above
  // proves the job fields, this proves they are what runMessage reads.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/gateway/api-runs.js", import.meta.url), "utf8");
  assert.match(src, /authorId: job\.principalKind === "user" \? job\.author : API_PRINCIPAL,\n\s+workspaceId/);
  assert.match(src, /untrustedPrincipal: job\.principalKind !== "user",/);
  assert.match(src, /menuOwnerId: job\.principalKind === "user" \? job\.author : "",/);
});

test("job list, status and stop answer only for the token's own conversation", async () => {
  const mine = tokens.createApiToken({ name: "mine", channelId: main.channelId, slug: main.slug, createdBy: "U_TOK_MEMBER" });
  const theirs = tokens.createApiToken({ name: "theirs", channelId: other.channelId, slug: other.slug, createdBy: "U_TOK_MEMBER" });
  const list = async (token) => (await (await get("/api/runs", { "x-api-key": token })).json()).jobs;
  const mineJobs = await list(mine.token);
  assert.ok(mineJobs.length >= 1, "the runs started above are visible to the conversation's token");
  assert.ok(mineJobs.every((j) => j.slug === main.slug));
  const theirJobs = await list(theirs.token);
  assert.equal(theirJobs.length, 0);
  const id = mineJobs[0].jobId;
  assert.equal((await get(`/api/runs/${id}`, { "x-api-key": mine.token })).status, 200);
  assert.equal((await get(`/api/runs/${id}`, { "x-api-key": theirs.token })).status, 404);
  assert.equal((await post(`/api/runs/${id}/stop`, {}, { "x-api-key": theirs.token })).status, 404);
  // The legacy key sees everything, as before.
  assert.ok((await list(LEGACY)).length >= mineJobs.length);
});

test("MCP tools: a person creates and sees their own tokens; managers/admins see all; the API principal gets none", async () => {
  const toolsFor = (claims) => {
    const map = new Map();
    const ctx = ctxFromClaims({ channelId: main.channelId, slug: main.slug, threadKey: "1700000000.000100", engine: "claude", ...claims });
    registerApiTokenTools({ registerTool: (name, _def, handler) => map.set(name, handler) }, ctx);
    return map;
  };
  const text = (r) => r.content[0].text;
  const member = toolsFor({ authorId: "U_TOK_MEMBER", principalTrusted: true });
  const admin = toolsFor({ authorId: "U_TOK_ADMIN", principalTrusted: true });
  const api = toolsFor({ authorId: "api", principalTrusted: false });
  const nobody = toolsFor({ authorId: "U_TOK_NOBODY", principalTrusted: true });

  const created = text(await member.get("create_api_token")({ name: "member flow" }));
  const value = created.match(/`(cgk_[A-Za-z0-9_-]+)`/)?.[1];
  assert.ok(value, "the value is returned once");
  assert.match(created, /curl -X POST/);
  assert.equal(tokens.resolveApiToken(value).createdBy, "U_TOK_MEMBER");
  assert.match(text(await api.get("create_api_token")({ name: "x" })), /Only a person/);
  assert.match(text(await nobody.get("create_api_token")({ name: "x" })), /not authorized/);

  const own = text(await member.get("list_api_tokens")({}));
  assert.match(own, /member flow/);
  assert.doesNotMatch(own, /`admin`|`nobody`/, "a member sees only their own tokens");
  assert.doesNotMatch(own, new RegExp(value.slice(8, 30)), "never the value");
  const all = text(await admin.get("list_api_tokens")({}));
  assert.match(all, /member flow/);
  assert.match(all, /`mine`/);

  const mineId = tokens.listApiTokens({ channelId: main.channelId }).find((t) => t.name === "mine").id;
  const memberOwn = tokens.listApiTokens({ channelId: main.channelId }).find((t) => t.name === "member flow").id;
  // The member owns "mine" (created above) and "member flow"; an admin's token is not theirs.
  const adminTok = tokens.createApiToken({ name: "admin-owned", channelId: main.channelId, slug: main.slug, createdBy: "U_TOK_ADMIN" });
  assert.match(text(await member.get("revoke_api_token")({ id: adminTok.record.id })), /Only the token's owner/);
  assert.match(text(await member.get("revoke_api_token")({ id: memberOwn })), /revoked/);
  assert.match(text(await admin.get("revoke_api_token")({ id: mineId })), /revoked/);
  assert.equal(tokens.resolveApiToken(value), null);
  // Another conversation's token is invisible here.
  const foreign = tokens.listApiTokens({ channelId: other.channelId })[0];
  assert.match(text(await admin.get("revoke_api_token")({ id: foreign.id })), /No such token in this conversation/);
});

test("the admin listing shows every token across conversations and never a value", async () => {
  const adminApp = express();
  adminApp.use(express.json());
  adminApp.use("/api", createApiTokensRouter());
  const s = await new Promise((resolve) => { const i = adminApp.listen(0, "127.0.0.1", () => resolve(i)); });
  after(() => s.close());
  const url = `http://127.0.0.1:${s.address().port}`;
  const body = await (await fetch(`${url}/api/api-tokens`)).json();
  assert.ok(body.tokens.length >= 4);
  assert.ok(body.tokens.some((t) => t.channelId === other.channelId));
  assert.ok(body.tokens.every((t) => t.channelName && !/^cgk_[A-Za-z0-9_-]{20,}/.test(JSON.stringify(t))));
  const live = body.tokens.find((t) => !t.revoked);
  const revoked = await (await fetch(`${url}/api/api-tokens/${live.id}/revoke`, { method: "POST" })).json();
  assert.equal(revoked.ok, true);
  assert.equal(revoked.token.revoked, true);
  assert.equal((await fetch(`${url}/api/api-tokens/${live.id}/revoke`, { method: "POST" })).status, 404);
});
