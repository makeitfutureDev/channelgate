import crypto from 'node:crypto';
import { ACTIVITY_THEME_CSS, ACTIVITY_BRAND } from './activity-theme.js';
import { ACTIVITY_APP_HEAD } from './activity-app.js';

async function accessBrowser({ mode, base, csrf, adminPasskeysAvailable }, env) {
  const { document, location, history, fetch, confirm, ChannelGatePasskeys: helper } = env;
  const el = id => document.getElementById(id);
  const status = el('status'), signIn = el('sign-in'), add = el('add-passkey');
  let busy = false;
  async function request(url, body, method = 'POST') {
    const response = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CG-Request': '1', ...(csrf ? { 'X-CG-CSRF': csrf } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Activity is unavailable. Open a new Dashboard link from Slack.');
    return data;
  }
  function navigate(data) {
    // The session page, or the one in-app destination a launch may carry (the voice-call page).
    if (!/^\/activity\/[A-Za-z0-9_-]{16}(\?call=[A-Z0-9_]{1,32}(&thread=\d{1,13}\.\d{1,6})?)?$/.test(data.url || '')) throw new Error('Activity is unavailable.');
    location.replace(data.url);
  }
  async function run(action) {
    if (busy) return;
    busy = true; status.textContent = '';
    for (const button of document.querySelectorAll('button')) button.disabled = true;
    try { await action(); } catch (error) { status.textContent = helper.errorMessage(error); }
    finally { busy = false; for (const button of document.querySelectorAll('button')) button.disabled = !helper.available() && (button === add || button === signIn); }
  }
  function render(keys) {
    const list = el('passkey-list'); list.replaceChildren();
    if (!keys.length) list.textContent = adminPasskeysAvailable ? 'No Activity-only passkeys saved.' : 'No passkeys saved yet.';
    for (const key of keys) {
      const row = document.createElement('li'), name = document.createElement('span'), remove = document.createElement('button');
      name.textContent = key.name;
      remove.type = 'button'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', 'Remove ' + key.name);
      remove.addEventListener('click', () => {
        if (!confirm('Remove this passkey? You can still open a new Dashboard link from Slack.')) return;
        void run(async () => {
          render((await request(base + '/api/passkeys/' + encodeURIComponent(key.id), undefined, 'DELETE')).passkeys);
          status.textContent = 'Passkey removed.';
        });
      });
      row.append(name, remove); list.append(row);
    }
  }
  if (signIn) {
    signIn.disabled = !helper.available();
    signIn.addEventListener('click', () => void run(async () => {
      const { options } = await request('/activity/auth/login/options', {});
      const response = await helper.get(options);
      navigate(await request('/activity/auth/login/verify', { response }));
    }));
  }
  if (add) {
    add.disabled = !helper.available();
    add.addEventListener('click', () => void run(async () => {
      const { options } = await request(base + '/api/passkeys/register/options', {});
      const response = await helper.create(options);
      render((await request(base + '/api/passkeys/register/verify', { response, name: el('passkey-name').value })).passkeys);
      el('passkey-name').value = ''; status.textContent = 'Passkey saved. You can now return using Sign in with a passkey.';
    }));
  }
  if (mode === 'manage') void run(async () => render((await request(base + '/api/passkeys', undefined, 'GET')).passkeys));
  if (!helper.available()) status.textContent = 'Passkeys need a supported browser and HTTPS (or localhost). You can still use your Dashboard link from Slack.';
  if (mode === 'open') {
    const secret = location.hash.slice(1); history.replaceState(null, '', location.pathname);
    return run(async () => {
      if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('This private link expired or is unavailable. Sign in with your saved passkey, or open a new Dashboard link from Slack.');
      status.textContent = 'Opening your private dashboard…';
      try { navigate(await request('/activity/exchange', { token: secret })); }
      catch { throw new Error('This private link expired or is unavailable. Sign in with your saved passkey, or open a new Dashboard link from Slack.'); }
    });
  }
}

export function activityAccessPage({ mode = 'login', base = '', csrf = '', adminPasskeysAvailable = false } = {}) {
  const nonce = crypto.randomBytes(16).toString('base64url');
  const manage = mode === 'manage';
  const config = JSON.stringify({ mode, base, csrf, adminPasskeysAvailable }).replaceAll('<', '\\u003c');
  return { nonce, html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${manage ? 'Passkeys' : 'Sign in'} · ChannelGate Activity</title><link rel="icon" type="image/svg+xml" href="/favicon.svg">${ACTIVITY_APP_HEAD}<style nonce="${nonce}">${ACTIVITY_THEME_CSS}
body{display:grid;place-items:center;min-height:100dvh;margin:0}main{box-sizing:border-box;margin:20px;padding:28px;width:min(480px,calc(100% - 40px));background:var(--panel);border:1px solid var(--line);border-radius:12px}.brand{margin-bottom:24px}h1{font-size:22px}p{color:var(--muted);line-height:1.6;font-size:14px}a{color:var(--orange);overflow-wrap:anywhere}button,input{box-sizing:border-box;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:7px;color:var(--ink);background:var(--panel-2)}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}input{display:block;width:100%;margin:8px 0 12px}label{font-size:14px}#status{min-height:1.6em}ul{list-style:none;padding:0}li{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:12px 0}li span{overflow-wrap:anywhere;min-width:0}li button{flex:none;font-size:13px}.primary{background:var(--orange);color:var(--brand-ink);border-color:var(--orange)}.return{margin-top:24px}#sign-in{width:100%}
</style></head><body><main>${ACTIVITY_BRAND}<h1>${manage ? 'Your Activity passkeys' : 'Your private Activity'}</h1>
${manage ? `${adminPasskeysAvailable ? '<p>Your administrator passkeys already work for Activity. You do not need another passkey.</p><p><a href="/settings#set-admin-access">Manage administrator passkeys</a></p><p>Any older Activity-only passkeys are listed below.</p>' : '<p>Save a passkey to sign back in without opening another Slack link.</p>'}<ul id="passkey-list" aria-label="Your passkeys"></ul>${adminPasskeysAvailable ? '' : '<label for="passkey-name">Passkey name</label><input id="passkey-name" maxlength="80" placeholder="My phone or laptop" autocomplete="off"><button id="add-passkey" class="primary" type="button">Add passkey</button>'}<p>Bookmark <a href="/activity/login">Activity sign-in</a> to return later.</p><p class="return"><a href="${base}">Back to Activity</a></p>` : `<p>Sign in with your saved passkey. Your administrator passkey works here too. To set up your first Activity passkey, open Dashboard from Slack, then choose Passkeys.</p><button id="sign-in" class="primary" type="button">Sign in with a passkey</button>`}
<p id="status" role="status" aria-live="polite"></p><noscript><p>Enable JavaScript to open Activity and use passkeys.</p></noscript></main><script nonce="${nonce}" src="/activity/passkeys.js"></script><script nonce="${nonce}">(${accessBrowser.toString()})(${config}, globalThis);</script></body></html>` };
}
