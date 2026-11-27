import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { ensureTestEnv } from './helpers.js';
ensureTestEnv();
const { getUser, setUser, isAdmin, getComposioToken } = await import('../src/config/store.js');
const { activityIdentityIds, setActivityIdentities } = await import('../src/config/activity-identities.js');
const { createUsersRouter } = await import('../src/web/routes/users.js');
let seq = 0;
async function fixture() {
  const suffix = ++seq;
  const owner = `U_ACTIVITY_${suffix}`;
  const chat = `activity-${suffix}@example.test`;
  const teams = `29:activity-${suffix}`;
  await setUser(owner, { approved: true });
  await setUser(chat, { approved: true, googleChatUserName: `users/activity-${suffix}` });
  await setUser(teams, { approved: true });
  return { owner, chat, teams };
}

test('explicit links combine exact identities, deduplicate and unlink immediately', async () => {
  const { owner, chat, teams } = await fixture();
  assert.deepEqual(await activityIdentityIds(owner), [owner]);
  assert.deepEqual(await setActivityIdentities(owner, [chat, teams, chat]), [chat, teams]);
  assert.deepEqual(await activityIdentityIds(owner), [owner, chat, teams]);
  assert.deepEqual(await activityIdentityIds(chat), [chat]);
  await setUser(owner, { approved: false });
  await setActivityIdentities(owner, []);
  assert.deepEqual((await getUser(owner)).activityIdentities, []);
  assert.deepEqual(await activityIdentityIds(owner), [owner]);
});

test('unknown, unapproved, unverified platform and self identities are refused', async () => {
  const { owner, chat } = await fixture();
  await setUser('U_ACTIVITY_FAKE_PLATFORM', { approved: true });
  await setUser(chat, { approved: false });
  for (const ids of [['unknown@example.test'], [chat], ['U_ACTIVITY_FAKE_PLATFORM'], [owner], 'not-an-array', [1]]) {
    await assert.rejects(setActivityIdentities(owner, ids), /Activity|existing approved|user IDs|already owns/);
  }
  await assert.rejects(setActivityIdentities('unknown-owner', []), /existing approved/);
});

test('one identity has one owner, cycles and nested assignments are refused', async () => {
  const { owner, chat, teams } = await fixture();
  const other = `U_ACTIVITY_OTHER_${seq}`;
  await setUser(other, { approved: true });
  await setActivityIdentities(owner, [chat]);
  await assert.rejects(setActivityIdentities(other, [chat]), /another Activity owner/);
  await assert.rejects(setActivityIdentities(chat, [teams]), /already linked/);
  await setActivityIdentities(owner, []);
  await setActivityIdentities(chat, [teams]);
  await assert.rejects(setActivityIdentities(owner, [chat]), /already owns linked/);
});

test('links never copy privilege, secrets or connector credentials and revocation narrows reads', async () => {
  const { owner, chat } = await fixture();
  await setUser(owner, { isAdmin: true, composioToken: 'owner-only-test-token', env: { PRIVATE_TEST: { value: 'private-test' } } });
  const before = await getUser(chat);
  await setActivityIdentities(owner, [chat]);
  assert.deepEqual(await getUser(chat), before);
  assert.equal(await isAdmin(chat), false);
  assert.equal(await getComposioToken(chat), '');
  assert.equal(await getComposioToken(owner), 'owner-only-test-token');
  await setUser(chat, { approved: false });
  assert.deepEqual(await activityIdentityIds(owner), [owner]);
});

test('trusted platform metadata supports opaque Teams IDs and Google resource IDs', async () => {
  const { owner } = await fixture();
  const opaque = `00000000-0000-0000-0000-${seq}`;
  const resource = `users/resource-${seq}`;
  await setUser(opaque, { approved: true, platform: 'msteams' });
  await setUser(resource, { approved: true });
  await setActivityIdentities(owner, [opaque, resource]);
  assert.deepEqual(await activityIdentityIds(owner), [owner, opaque, resource]);
});

const app = express();
app.use(express.json());
app.use(createUsersRouter());
const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());
test('admin user routes expose safe identity metadata and support separate link updates', async () => {
  const { owner, chat } = await fixture();
  const response = await fetch(`${base}/users/${owner}/activity-identities`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activityIdentities: [chat] }),
  });
  assert.equal(response.status, 200);
  const listed = await (await fetch(`${base}/users`)).json();
  assert.deepEqual(listed.users[owner].activityIdentities, [chat]);
  assert.equal(listed.users[chat].activityPlatform, 'googlechat');
  assert.equal('composioToken' in listed.users[owner], false);
  const invalid = await fetch(`${base}/users/${owner}/activity-identities`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activityIdentities: ['unknown'] }),
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await activityIdentityIds(owner), [owner, chat]);
});
