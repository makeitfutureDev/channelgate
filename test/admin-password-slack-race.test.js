import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ensureTestEnv } from './helpers.js';

ensureTestEnv();
delete process.env.ADMIN_PASSWORD;
const settings = await import('../src/config/settings.js');
const accounts = await import('../src/config/admin-accounts.js');
const { setUser } = await import('../src/config/store.js');
const { hashPassword } = await import('../src/web/security.js');
const { createAdminSession } = await import('../src/web/auth.js');
const { createWebApp } = await import('../src/web/app.js');

test('bootstrap alternate-login enable cannot overwrite a password rotated while its verification yields', async t => {
  const password = 'disposable-original-bootstrap-password';
  const rotatedHash = await hashPassword('disposable-rotated-bootstrap-password');
  settings.saveSettings({ publicUrl: '', adminPassword: await hashPassword(password), adminPasswordSlackEnabled: false });
  await setUser('URACEADMIN', { name: 'Fixture administrator', isAdmin: true });
  const account = accounts.ensureUserAdminAccount('URACEADMIN');
  let cookie;
  createAdminSession({ headers: {} }, { setHeader: (_name, value) => { cookie = value.split(';')[0]; } }, account, { bootstrap: true });
  const app = createWebApp({ adminIdentityDelivery: async () => true });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://localhost:${server.address().port}`;
  const originalScrypt = crypto.scrypt;
  t.after(() => { crypto.scrypt = originalScrypt; });
  let resumeVerification;
  let signalVerification;
  const verificationStarted = new Promise(resolve => { signalVerification = resolve; });
  crypto.scrypt = (...args) => {
    // Pause exactly the first password verification, then restore the real asynchronous primitive.
    crypto.scrypt = originalScrypt;
    resumeVerification = () => originalScrypt(...args);
    signalVerification();
  };
  const enabling = fetch(`${base}/api/auth/password-slack/settings`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CG-Request': '1', Origin: base, Cookie: cookie },
    body: JSON.stringify({ enabled: true, password }),
  });
  await verificationStarted;
  settings.saveSettings({ adminPassword: rotatedHash });
  resumeVerification();
  const response = await enabling;
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /Authentication changed/);
  assert.equal(settings.getSettings().adminPasswordSlackEnabled, false);
  assert.equal(settings.getAdminPassword(), rotatedHash, 'the stale bootstrap request cannot restore its old password');
});
