// What may leave the admin API when a stored record still carries a secret nobody reads any more.
//
// `GET /api/channels` masks the tokens it knows about and then spreads the rest of the meta
// record. A field belonging to a RETIRED integration is in neither set: no code reads it, so no
// masker names it, and the spread hands it back in cleartext. That is how `skillsToken` — the
// Skills Manager MCP token, dead since the local skills catalog replaced that integration — was
// still being served in full to anyone who could reach the admin API.
//
// The guarantee these tests pin down is deliberately shaped as "no such key anywhere in the
// response", not "this one field is masked": a mask that has to be extended per field is the thing
// that failed. Same for the users listing, which is built from an explicit allowlist and must stay
// that way.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { createAdminRouter } = await import("../src/web/routes/admin.js");
const { getDb, toJson } = await import("../src/db/index.js");
const {
  defaultChannelMeta,
  getChannelMeta,
  getUsers,
  saveChannelMeta,
  setUser,
  upsertChannelEntry,
} = await import("../src/config/store.js");

const DEAD_TOKEN = "sm_live_dead_skills_token_9999";

const app = express();
app.use(express.json());
app.use(createAdminRouter({ slack: { snapshot: () => ({ status: "disconnected", connected: false }) } }));
const server = await new Promise((resolve) => {
  const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
});
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const get = async (path) => {
  const response = await fetch(base + path);
  const body = await response.text();
  return { status: response.status, body, json: JSON.parse(body) };
};

// Write the dead field the way a pre-upgrade install holds it: straight into the row, bypassing
// the store's normalizer. Nothing in src/ can produce this record any more — only history can.
function plantDeadChannelField(slug, meta) {
  getDb()
    .prepare("INSERT INTO channel_meta(slug, data) VALUES(?, ?) ON CONFLICT(slug) DO UPDATE SET data = excluded.data")
    .run(slug, toJson({ ...meta, skillsToken: DEAD_TOKEN }));
}

function plantDeadUserField(userId, record) {
  getDb()
    .prepare("INSERT INTO users(user_id, data) VALUES(?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data")
    .run(userId, toJson({ ...record, skillsToken: DEAD_TOKEN }));
}

test("no channel read returns a retired integration's stored token", async () => {
  const entry = await upsertChannelEntry("C_DEADFIELD", { name: "dead-field-channel", type: "channel", isDM: false });
  await saveChannelMeta(
    entry.slug,
    defaultChannelMeta({ channelId: "C_DEADFIELD", name: "dead-field-channel", type: "channel", isDM: false }),
  );
  plantDeadChannelField(entry.slug, await getChannelMeta(entry.slug));
  // Precondition: the value really is in the store, so a passing assertion below means the API
  // withheld it rather than that there was nothing to withhold.
  assert.equal((await getChannelMeta(entry.slug)).skillsToken, DEAD_TOKEN);

  const listed = await get("/channels");
  assert.equal(listed.status, 200);
  const channel = listed.json.channels.find((c) => c.slug === entry.slug);
  assert.ok(channel, "the planted channel must be in the listing");
  assert.equal(Object.hasOwn(channel.meta, "skillsToken"), false, "no skillsToken key may survive the mask");
  assert.equal(listed.body.includes(DEAD_TOKEN), false, "the value must not appear anywhere in the response");

  // The live tokens are masked the way they always were — the fix must not have loosened those.
  assert.equal(channel.meta.composioToken, undefined);
  assert.equal(Object.hasOwn(channel.meta, "hasComposioToken"), true);
  assert.equal(Object.hasOwn(channel.meta, "hasMakeToolboxKey"), true);
});

test("a DM's meta is masked by the same masker as a channel's", async () => {
  // The DM listing used to carry its own copy of the masking shape, which had drifted: it masked
  // Composio and Toolbox but neither the Make toolbox key nor anything dead.
  const entry = await upsertChannelEntry("D_DEADFIELD", { name: "dm-dead-field", type: "im", isDM: true });
  await saveChannelMeta(
    entry.slug,
    defaultChannelMeta({ channelId: "D_DEADFIELD", name: "dm-dead-field", type: "im", isDM: true }),
  );
  plantDeadChannelField(entry.slug, { ...(await getChannelMeta(entry.slug)), makeToolboxKey: "mk_live_key_4321" });

  const listed = await get("/dms");
  assert.equal(listed.status, 200);
  const dm = listed.json.dms.find((d) => d.slug === entry.slug);
  assert.ok(dm, "the planted DM must be in the listing");
  assert.equal(Object.hasOwn(dm.meta, "skillsToken"), false);
  assert.equal(dm.meta.makeToolboxKey, undefined, "the Make toolbox key is a secret here too");
  assert.equal(dm.meta.makeToolboxKeyLast4, "4321");
  assert.equal(listed.body.includes(DEAD_TOKEN), false);
  assert.equal(listed.body.includes("mk_live_key_4321"), false);
});

test("/users never emits a retired integration's personal token", async () => {
  await setUser("U_DEADFIELD", { name: "Dead Field", approved: true });
  plantDeadUserField("U_DEADFIELD", (await getUsers()).U_DEADFIELD);
  assert.equal((await getUsers()).U_DEADFIELD.skillsToken, DEAD_TOKEN);

  const listed = await get("/users");
  assert.equal(listed.status, 200);
  assert.equal(Object.hasOwn(listed.json.users.U_DEADFIELD, "skillsToken"), false);
  assert.equal(listed.body.includes(DEAD_TOKEN), false, "the users listing is an allowlist, not a spread");
});

test("the next write drops the dead field instead of preserving it", async () => {
  // Masking hides the value from one response; the record still holds it. A save must actually
  // remove it, so the exposure ends at the next write even on an install that skipped migration 20.
  const entry = await upsertChannelEntry("C_DEADWRITE", { name: "dead-field-write", type: "channel", isDM: false });
  const meta = defaultChannelMeta({ channelId: "C_DEADWRITE", name: "dead-field-write", type: "channel", isDM: false });
  plantDeadChannelField(entry.slug, meta);

  const saved = await saveChannelMeta(entry.slug, { ...(await getChannelMeta(entry.slug)), model: "sonnet" });
  assert.equal(Object.hasOwn(saved, "skillsToken"), false, "the returned record is the written one");
  assert.equal(Object.hasOwn(await getChannelMeta(entry.slug), "skillsToken"), false);
  assert.equal((await getChannelMeta(entry.slug)).model, "sonnet", "the rest of the record is preserved");

  plantDeadUserField("U_DEADWRITE", { name: "Dead Write", approved: true });
  await setUser("U_DEADWRITE", { name: "Dead Write II" });
  assert.equal(Object.hasOwn((await getUsers()).U_DEADWRITE, "skillsToken"), false);
  assert.equal((await getUsers()).U_DEADWRITE.name, "Dead Write II");
});

test("migration 20 clears the field from the rows that already carry it", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { migrations } = await import("../src/db/migrations.js");
  const { runMigrations } = await import("../src/db/index.js");

  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT)");
    // Build the schema as it stood BEFORE the cleanup, then plant the rows an upgrade would find.
    const upgrade = migrations.find((m) => m.version === 20);
    assert.ok(upgrade, "migration 20 must exist");
    for (const m of migrations) {
      if (m.version >= 20) continue;
      m.up(db);
    }
    db.prepare("INSERT INTO channel_meta(slug, data) VALUES(?, ?)").run("ops", JSON.stringify({ model: "sonnet", skillsToken: DEAD_TOKEN }));
    db.prepare("INSERT INTO channel_meta(slug, data) VALUES(?, ?)").run("clean", JSON.stringify({ model: "opus" }));
    db.prepare("INSERT INTO channel_meta(slug, data) VALUES(?, ?)").run("broken", "{not json");
    db.prepare("INSERT INTO users(user_id, data) VALUES(?, ?)").run("U1", JSON.stringify({ name: "A", skillsToken: DEAD_TOKEN }));

    upgrade.up(db);

    const meta = JSON.parse(db.prepare("SELECT data FROM channel_meta WHERE slug = 'ops'").get().data);
    assert.equal(Object.hasOwn(meta, "skillsToken"), false);
    assert.equal(meta.model, "sonnet", "everything else in the blob survives");
    assert.equal(db.prepare("SELECT data FROM channel_meta WHERE slug = 'clean'").get().data, JSON.stringify({ model: "opus" }));
    assert.equal(db.prepare("SELECT data FROM channel_meta WHERE slug = 'broken'").get().data, "{not json", "an unreadable blob is left alone");
    assert.equal(Object.hasOwn(JSON.parse(db.prepare("SELECT data FROM users WHERE user_id = 'U1'").get().data), "skillsToken"), false);

    // Idempotent: applying it again changes nothing.
    upgrade.up(db);
    assert.equal(JSON.parse(db.prepare("SELECT data FROM channel_meta WHERE slug = 'ops'").get().data).model, "sonnet");
  } finally {
    db.close();
  }
  // Sanity: a fully migrated database really is at or past this version.
  assert.ok(Math.max(...migrations.map((m) => m.version)) >= 20);
  assert.ok(runMigrations, "the runner is exported for the fixtures above");
});
