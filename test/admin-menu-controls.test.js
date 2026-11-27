import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureTestEnv } from "./helpers.js";
ensureTestEnv();
const { useFakeRuntime } = await import("./runtime-fake.js");
await useFakeRuntime();
const store = await import("../src/config/store.js");
const { patchUserEnv } = await import("../src/config/scoped-env.js");
const { effectiveWorkDir } = await import("../src/gateway/folders.js");
const { openChannelMenuControl, handleSecretsAction, handleMenuResumeAction } = await import("../src/slack/app.js");
let sequence = 0;
async function fixture() {
  const channel = `CADMINMENU${++sequence}`;
  const owner = `UOWNER${sequence}`, admin = `UADMIN${sequence}`, member = `UMEMBER${sequence}`;
  const entry = await store.upsertChannelEntry(channel, { name: `admin-menu-${sequence}`, type: "channel" });
  await store.saveChannelMeta(entry.slug, { ...await store.getChannelMeta(entry.slug), access: "approved", isDM: false });
  await mkdir(effectiveWorkDir(entry.slug, await store.getChannelMeta(entry.slug)), { recursive: true });
  await store.setUser(owner, { name: "Owner", approved: true });
  await store.setUser(member, { name: "Member", approved: true });
  await store.setUser(admin, { name: "Admin", approved: true, isAdmin: true });
  await patchUserEnv(owner, { set: { name: "OWNER_PRIVATE", value: "dummy-owner-1111" } });
  await patchUserEnv(admin, { set: { name: "ADMIN_PRIVATE", value: "dummy-admin-2222" } });
  const control = { members: [owner, member, admin] }, opened = [], updates = [], notices = [];
  const client = {
    conversations: { members: async () => ({ members: control.members, response_metadata: {} }) },
    users: { info: async () => ({ user: { real_name: "Menu test" } }) },
    views: {
      open: async (args) => { opened.push(args); return { view: { id: "VADMINMENU" } }; },
      update: async (args) => { updates.push(args); return { ok: true }; },
    },
    chat: { postEphemeral: async (args) => { notices.push(args); return { ok: true }; } },
  };
  const body = { user: { id: admin }, channel: { id: channel }, trigger_id: "trigger" };
  const command = { o: "open", c: channel, t: "100.1", u: owner };
  return { channel, owner, admin, member, entry, control, opened, updates, notices, client, body, command };
}
for (const kind of ["files", "variables", "settings"]) {
  test(`admin opens another requester's ${kind} as their own view`, async () => {
    const f = await fixture();
    await openChannelMenuControl({ ...f, kind });
    assert.equal(f.opened.length, 1);
    const view = f.updates.at(-1)?.view || f.opened[0].view;
    const metadata = JSON.parse(view.private_metadata);
    assert.equal(metadata.u, f.admin);
    assert.equal(metadata.c, f.channel);
    assert.equal(metadata.t, "100.1");
    if (kind === "variables") {
      assert.match(JSON.stringify(view), /ADMIN_PRIVATE/);
      assert.doesNotMatch(JSON.stringify(view), /OWNER_PRIVATE/);
    }
    assert.doesNotMatch(JSON.stringify(view), /dummy-owner|dummy-admin/);
  });
  test(`${kind} rejects foreign members, demoted admins, nonmembers and a different channel`, async () => {
    for (const variant of ["member", "demoted", "membership", "channel", "missing-user"]) {
      const f = await fixture();
      if (variant === "member") f.body.user.id = f.member;
      if (variant === "demoted") await store.setUser(f.admin, { isAdmin: false });
      if (variant === "membership") f.control.members = [f.owner];
      if (variant === "channel") f.body.channel.id = "COTHER";
      if (variant === "missing-user") delete f.body.user;
      await assert.rejects(() => openChannelMenuControl({ ...f, kind }));
      assert.equal(f.opened.length, 0, variant);
    }
  });
  test(`${kind} still opens owned and unbound controls for ordinary members`, async () => {
    for (const owner of ["self", "unbound"]) {
      const f = await fixture();
      f.body.user.id = f.member;
      f.command.u = owner === "self" ? f.member : "";
      await openChannelMenuControl({ ...f, kind });
      assert.equal(f.opened.length, 1);
      assert.equal(JSON.parse(f.opened[0].view.private_metadata).u, f.member);
    }
  });
}
test("admin direct file button preserves the requested preview path", async () => {
  const f = await fixture();
  const root = effectiveWorkDir(f.entry.slug, await store.getChannelMeta(f.entry.slug));
  await writeFile(path.join(root, "menu-fixture.txt"), "Admin preview fixture");
  f.command = { ...f.command, o: "open_file", p: "menu-fixture.txt" };
  await openChannelMenuControl({ ...f, kind: "files" });
  assert.match(JSON.stringify(f.updates.at(-1).view), /Admin preview fixture/);
  assert.equal(JSON.parse(f.updates.at(-1).view.private_metadata).u, f.admin);
});
test("Variables action uses the admin override and opens the admin's own form", async () => {
  const f = await fixture();
  await handleSecretsAction({ ...f, ack: async () => {}, action: { value: JSON.stringify(f.command) } });
  assert.equal(f.opened.length, 1);
  assert.equal(JSON.parse(f.opened[0].view.private_metadata).u, f.admin);
  assert.match(JSON.stringify(f.opened[0].view), /ADMIN_PRIVATE/);
  assert.doesNotMatch(JSON.stringify(f.opened[0].view), /OWNER_PRIVATE/);
});
test("admin can open a legacy Resume menu owned by another requester", async () => {
  const f = await fixture();
  await handleMenuResumeAction({ ...f, ack: async () => {}, action: { value: JSON.stringify(f.command) } });
  assert.equal(f.opened.length, 1);
  assert.match(JSON.stringify(f.opened[0].view), /No session/);
});
