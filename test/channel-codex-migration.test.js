// The one-time boot step that turns a channel's own Codex account (the retired `codex-channel`
// harness) into an engine license limited to that channel, keeping its sign-in.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ensureTestEnv, testLicenseEnv } from "./helpers.js";

ensureTestEnv();
testLicenseEnv({ tier: "enterprise" });
const { getDb, metaGet } = await import("../src/db/index.js");
const { saveSettings, getSettings } = await import("../src/config/settings.js");
const { upsertChannelEntry, saveChannelMeta, getChannelMeta, defaultChannelMeta } = await import("../src/config/store.js");
const { channelCodexHome } = await import("../src/gateway/channel-codex-paths.js");
const { licenseLoginHome, normalizeLicenseRecords } = await import("../src/engines/license-state.js");
const { migrateChannelCodexAccounts, MIGRATION_FLAG } = await import("../src/gateway/channel-codex-migration.js");
const { preserveMigratedChannelCodexHistory } = await import("../src/engines/codex-channel-history.js");
const { adapterFor } = await import("../src/engines/registry.js");

const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const REFRESH = "fixture-refresh-token-value";
const API_KEY = "sk-fixture-channel-account-0123456789";

async function legacyChannel(channelId, name, auth) {
  const entry = await upsertChannelEntry(channelId, { name, type: "channel", isDM: false, platform: "slack" });
  // Written as the legacy UI left it (the store gate is not the subject here).
  const meta = { ...defaultChannelMeta({ channelId, name, type: "channel", isDM: false }), codexAuthSource: "channel", engine: "codex-channel", approvedEngines: ["codex-channel", "claude"] };
  getDb().prepare("INSERT INTO channel_meta(slug, data) VALUES(?, ?) ON CONFLICT(slug) DO UPDATE SET data = excluded.data").run(entry.slug, JSON.stringify(meta));
  if (auth) {
    const home = channelCodexHome(channelId);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(home, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
    writeFileSync(path.join(home, "history.jsonl"), "kept\n");
  }
  const db = getDb();
  db.prepare("INSERT INTO sessions(slug, thread_key, session_id, engine) VALUES(?, ?, ?, ?)").run(entry.slug, "T1", "sess-1", "codex-channel");
  db.prepare("INSERT INTO thread_overrides(slug, thread_key, kind, value) VALUES(?, ?, 'engine', 'codex-channel')").run(entry.slug, "T1");
  db.prepare("INSERT INTO thread_overrides(slug, thread_key, kind, value) VALUES(?, ?, 'license_pool', ?)").run(entry.slug, "T1", JSON.stringify(["codex-channel", "codex"]));
  return entry;
}

test("channel Codex accounts become channel-limited licenses, keeping their sign-in and every pin", async () => {
  saveSettings({ engineLicenses: [], engine: "claude", engineEnabled: { claude: true, codex: true } });
  const chat = await legacyChannel("C_MIG_CHATGPT", "customer-a", { tokens: { access_token: jwt({ "https://api.openai.com/auth": { chatgpt_plan_type: "team" } }), refresh_token: REFRESH } });
  const keyed = await legacyChannel("C_MIG_APIKEY", "customer-b", { OPENAI_API_KEY: API_KEY });
  const empty = await legacyChannel("C_MIG_EMPTY", "customer-c", null);
  const untouched = await upsertChannelEntry("C_MIG_GATEWAY", { name: "plain", type: "channel", isDM: false, platform: "slack" });
  await saveChannelMeta(untouched.slug, defaultChannelMeta({ channelId: "C_MIG_GATEWAY", name: "plain", type: "channel", isDM: false }));
  const lines = [];
  const result = await migrateChannelCodexAccounts({ log: (line) => lines.push(line) });
  assert.equal(result.failed, false);
  assert.equal(metaGet(MIGRATION_FLAG), "1");

  const records = normalizeLicenseRecords(getSettings().engineLicenses);
  const login = records.find((record) => record.channelId === "C_MIG_CHATGPT");
  const api = records.find((record) => record.channelId === "C_MIG_APIKEY");
  assert.equal(login.kind, "codex-login");
  assert.equal(login.type, "business", "the declared type comes from the plan the sign-in reports");
  assert.match(login.label, /customer-a/);
  assert.equal(api.kind, "codex-api");
  assert.equal(api.apiKey, API_KEY);
  assert.equal(api.baseUrl, "https://api.openai.com/v1");
  assert.equal(records.some((record) => record.channelId === "C_MIG_EMPTY"), false, "no sign-in, no license");
  assert.equal(getSettings().engineEnabled[login.id], true);

  // The ChatGPT login directory MOVED (one auth.json, one refresh token): no re-login.
  assert.equal(existsSync(channelCodexHome("C_MIG_CHATGPT")), false);
  assert.equal(JSON.parse(readFileSync(path.join(licenseLoginHome(login.id), "auth.json"), "utf8")).tokens.refresh_token, REFRESH);
  assert.equal(readFileSync(path.join(licenseLoginHome(login.id), "history.jsonl"), "utf8"), "kept\n");
  // The API key lives in the write-only record only.
  assert.equal(existsSync(path.join(licenseLoginHome(api.id), "auth.json")), false);
  assert.equal((await adapterFor(login.id).licenseStatus()).signedIn, true, "the moved sign-in answers for the license");

  for (const [entry, id] of [[chat, login.id], [keyed, api.id]]) {
    const meta = await getChannelMeta(entry.slug);
    assert.equal(meta.codexAuthSource, "gateway");
    assert.equal(meta.engine, id);
    assert.deepEqual(meta.approvedEngines, [id, "claude"]);
    assert.equal(meta.codexChannelLicense, id);
    const db = getDb();
    assert.equal(db.prepare("SELECT engine FROM sessions WHERE slug = ? AND thread_key = 'T1'").get(entry.slug).engine, id);
    assert.equal(db.prepare("SELECT value FROM thread_overrides WHERE slug = ? AND thread_key = 'T1' AND kind = 'engine'").get(entry.slug).value, id);
    assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM thread_overrides WHERE slug = ? AND thread_key = 'T1' AND kind = 'license_pool'").get(entry.slug).value), [id, "codex"]);
  }
  const plain = await getChannelMeta(empty.slug);
  assert.equal(plain.codexAuthSource, "gateway");
  assert.equal(plain.engine, "");
  assert.deepEqual(plain.approvedEngines, ["claude"]);
  assert.equal(getDb().prepare("SELECT value FROM thread_overrides WHERE slug = ? AND kind = 'engine'").get(empty.slug), undefined);
  assert.equal((await getChannelMeta(untouched.slug)).codexChannelLicense, undefined);
  assert.ok(!lines.join("\n").includes(API_KEY) && !lines.join("\n").includes(REFRESH), "nothing secret is logged");

  // Once only.
  const again = await migrateChannelCodexAccounts({ log: () => {} });
  assert.equal(again.skipped, true);
  assert.equal(normalizeLicenseRecords(getSettings().engineLicenses).length, 2);
});

test("a thread resumed on the migrated license carries its rollout from the legacy directories", async () => {
  const spawned = [];
  const target = {
    backend: "container", cwd: "/w",
    meta: { codexChannelLicense: "codex-lic-0000abcd", codexChannelLegacyHistory: true },
    container: { home: "/home/agent" },
    runtime: { spawn: (_target, spec) => { spawned.push(spec); const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); setImmediate(() => { child.stdout.emit("data", "{}"); child.emit("close", 0); }); return child; } },
  };
  const ctx = { target, session: { id: "sess-1", fresh: false }, runtime: {} };
  assert.equal(await preserveMigratedChannelCodexHistory(ctx, { licenseId: "codex-lic-0000ffff", destinationRoot: "/x" }), null, "only the channel's own migrated license");
  await preserveMigratedChannelCodexHistory(ctx, { licenseId: "codex-lic-0000abcd", destinationRoot: "/home/agent/.cg-licenses/codex-lic-0000abcd" });
  assert.equal(spawned.length, 2);
  assert.match(spawned[0].args.at(-1), /\/home\/agent\/\.codex-channel"/);
  assert.match(spawned[1].args.at(-1), /\/home\/agent\/\.codex"/);
  assert.ok(spawned.every((spec) => spec.args.at(-1).includes("/home/agent/.cg-licenses/codex-lic-0000abcd")));
});
