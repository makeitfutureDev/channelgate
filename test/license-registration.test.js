import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import express from "express";
import { ensureTestEnv, clearTestLicense, testLicenseEnv } from "./helpers.js";

ensureTestEnv();
const { getDb } = await import("../src/db/index.js");
const { setUser, getUser, upsertChannelEntry, getChannelsIndex } = await import("../src/config/store.js");
const { getEffectiveLimits, getLicenseStatus } = await import("../src/ee/license.js");
const { normalizeLimits } = await import("../src/ee/tiers.js");
const { createUsersRouter } = await import("../src/web/routes/users.js");
const { createRunsRouter } = await import("../src/web/routes/runs.js");

function reset(tier = "free") {
  getDb().exec("DELETE FROM channels; DELETE FROM users; DELETE FROM channel_meta;");
  if (tier === "none") clearTestLicense();
  else testLicenseEnv({ tier });
}
const rejected = { code: "license_registration_limit", statusCode: 403 };
async function fill(n = 20) {
  for (let i = 0; i < n; i++) {
    await upsertChannelEntry(`C${i}`, { name: `channel-${i}`, isDM: i === 0 });
    await setUser(`U${i}`, { approved: i % 2 === 0, isAdmin: i === 0 });
  }
}

test("signed legacy null or omitted capacity fields cannot exceed Registered caps", () => {
  for (const fields of [{}, { channels: null, users: null }, { channels: 200, users: 200 }]) {
    reset();
    testLicenseEnv({ tier: "free", limits: fields });
    assert.equal(getEffectiveLimits().channels, 20);
    assert.equal(getEffectiveLimits().users, 20);
    assert.equal(getLicenseStatus().features.channelHarnessPolicy, false);
  }
  assert.equal(normalizeLimits({ channels: 10, users: 3 }, "free").channels, 10);
  reset("enterprise");
  assert.equal(getEffectiveLimits().channels, null);
  assert.equal(getEffectiveLimits().users, null);
  assert.equal(getLicenseStatus().features.channelHarnessPolicy, true);
});

for (const tier of ["free", "none"]) {
  test(`${tier}: the twentieth channel/user succeeds, twenty-first fails, existing updates work`, async () => {
    reset(tier);
    await fill();
    await assert.rejects(upsertChannelEntry("C21"), rejected);
    await assert.rejects(setUser("U21", {}), rejected);
    await setUser("api", { approved: true });
    await setUser("U0", { name: "updated" });
    await upsertChannelEntry("C0", { name: "updated" });
    assert.equal((await getUser("U0")).name, "updated");
    assert.equal(Object.keys(await getChannelsIndex()).length, 20);
    assert.equal(await getUser("U21"), null);
    assert.equal(getEffectiveLimits().conversations, tier === "none" ? 1 : null);
  });
}

test("Enterprise admits above twenty; a downgrade preserves all records and blocks only growth", async () => {
  reset("enterprise");
  await fill(25);
  testLicenseEnv({ tier: "free" });
  await setUser("U24", { name: "retained" });
  await upsertChannelEntry("C24", { name: "retained" });
  await assert.rejects(upsertChannelEntry("new"), rejected);
  await assert.rejects(setUser("new", {}), rejected);
  assert.equal(Object.keys(await getChannelsIndex()).length, 25);
  assert.equal((await getUser("U24")).name, "retained");
});

function registerInChild(id) {
  const script = `const {setUser,upsertChannelEntry}=await import('./src/config/store.js');
    const results=await Promise.allSettled([setUser('${id}',{}),upsertChannelEntry('${id}',{name:'${id}'})]);
    console.log(JSON.stringify(results.map(r=>r.status==='fulfilled'?'ok':r.reason.code)));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), env: process.env });
    let out = "", err = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err += chunk; });
    child.once("error", reject);
    child.once("close", code => code ? reject(new Error(err)) : resolve(JSON.parse(out.trim().split("\n").at(-1))));
  });
}

test("two processes racing the last slots cannot exceed either cap", async () => {
  reset();
  await fill(19);
  const results = (await Promise.all([registerInChild("race-a"), registerInChild("race-b")])).flat();
  assert.equal(results.filter(x => x === "ok").length, 2);
  assert.equal(results.filter(x => x === "license_registration_limit").length, 2);
  assert.equal(Object.keys(await getChannelsIndex()).length, 20);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM users").get().n, 20);
});

test("admin user creation and synthetic API conversation creation return clear JSON 403", async t => {
  reset();
  await fill();
  const app = express();
  app.use(express.json());
  app.use("/api", createUsersRouter());
  app.use("/runs", createRunsRouter());
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [url, method, body] of [["/api/users/new", "PUT", { name: "new" }], ["/runs", "POST", { message: "hello" }]]) {
    const response = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 403);
    const result = await response.json();
    assert.equal(result.code, "license_registration_limit");
    assert.match(result.error, /limit of 20/);
  }
});

test("Slack, Teams and Google Chat surface channel refusal before any run", async () => {
  reset();
  await fill();
  const { processMessageEvent } = await import("../src/slack/message-pipeline.js");
  const posted = [];
  await processMessageEvent({ type: "message", channel: "DNEW", channel_type: "im", user: "U0", text: "hello", ts: "1.0" }, {
    users: { info: async () => ({ user: { real_name: "Test" } }) },
    conversations: { info: async () => ({ channel: { id: "DNEW", is_im: true } }) },
    chat: { postMessage: async message => { posted.push(message); } },
  });
  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /limit of 20 registered channels/);
  const { createIngest } = await import("../src/platforms/ingest.js");
  for (const platform of ["googlechat", "msteams"]) {
    const replies = [];
    const ingest = createIngest({ connector: { platform, post: async message => { replies.push(message); } }, run: () => assert.fail("must not spawn") });
    const result = await ingest({ platform, conversationId: `${platform}:new`, rawConversationId: "new", isDM: true, kind: "dm", userId: "U0", text: "hello", attachments: [] });
    assert.equal(result.skipped, "license_registration_limit");
    assert.match(replies[0].text, /limit of 20 registered channels/);
  }
});
