import { api } from "./admin-api.js";

const passkeys = () => window.ChannelGatePasskeys;

// Called from a user action (settings, secret reveal, account/key management). The server is
// authoritative about freshness; never cache a password or an assertion in browser storage.
export async function freshAdminAuth({ force = false } = {}) {
  const me = await api("/api/auth/me", { cache: "no-store" });
  if (me.bootstrap) throw new Error("Create your first passkey under Settings → Admin access before continuing.");
  if (!force && me.fresh) return true;
  try {
    const { options } = await api("/api/auth/reauth/options", { method: "POST", body: "{}" });
    const response = await passkeys().get(options);
    await api("/api/auth/reauth/verify", { method: "POST", body: JSON.stringify({ response }) });
    return true;
  } catch (error) {
    throw new Error(passkeys().errorMessage(error));
  }
}

const dateLabel = (value) => {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
};

export async function mountAdminAccess(container, { confirm = async () => false } = {}) {
  if (!container) return;
  container.innerHTML = `
    <h4>Admin access</h4>
    <p class="desc">Individual admin accounts sign in with passkeys. Changes here save immediately.</p>
    <p class="admin-access-identity" data-access="identity">Loading your account…</p>
    <p class="admin-access-bootstrap" data-access="bootstrap" hidden>Create your first passkey to finish setup. The existing admin password stops working after enrollment.</p>
    <form data-access="register-form" class="admin-access-form">
      <label class="field"><span>Passkey name</span><input data-access="key-name" type="text" autocomplete="off" placeholder="For example, work laptop or spare key" required maxlength="100" /></label>
      <button type="submit" data-access="register">Add a passkey</button>
    </form>
    <p class="desc">Register a spare passkey so you can still sign in if you lose your primary device. Your last passkey cannot be removed here.</p>
    <ul class="admin-access-list" data-access="keys" aria-label="Your passkeys"></ul>
    <div class="admin-access-subhead"><h4>Admin accounts</h4><button type="button" class="ghost" data-access="reauth">Verify identity</button></div>
    <p class="desc">Each account has full dashboard administration access. Chat-platform administrator permissions are managed separately.</p>
    <ul class="admin-access-list" data-access="accounts" aria-label="Admin accounts"></ul>
    <form data-access="account-form" class="admin-access-form admin-access-account-form">
      <label class="field"><span>Username</span><input data-access="account-username" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" required maxlength="64" placeholder="Username" /></label>
      <label class="field"><span>Display name</span><input data-access="account-name" type="text" autocomplete="off" required maxlength="100" placeholder="Display name" /></label>
      <button type="submit">Create admin account</button>
    </form>
    <div class="admin-access-invite" data-access="invite" hidden>
      <p class="desc">Share this single-use setup link privately with the intended admin. It expires in 15 minutes and is shown only until you leave this page.</p>
      <label class="field"><span>Private setup link</span><input data-access="invite-url" type="text" readonly autocomplete="off" /></label>
      <button type="button" class="ghost" data-access="copy">Copy setup link</button>
      <button type="button" class="ghost" data-access="dismiss">Dismiss link</button>
    </div>
    <p class="admin-access-message" data-access="message" role="status" aria-live="polite"></p>`;
  const at = (name) => container.querySelector(`[data-access="${name}"]`);
  let me;
  let busy = false;

  function message(text, error = false) {
    at("message").textContent = text;
    at("message").classList.toggle("error", error);
  }

  function showInvite(setupUrl) {
    at("invite-url").value = setupUrl;
    at("invite").hidden = false;
  }

  function row(title, detail, buttonLabel, action, disabled = false) {
    const item = document.createElement("li");
    const text = document.createElement("div");
    const heading = document.createElement("strong");
    heading.textContent = title;
    const secondary = document.createElement("small");
    secondary.textContent = detail;
    text.append(heading, secondary);
    item.append(text);
    if (action) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost";
      button.textContent = buttonLabel;
      button.disabled = disabled;
      button.dataset.unavailable = String(disabled);
      button.addEventListener("click", action);
      item.append(button);
    }
    return item;
  }

  async function refresh() {
    const [accountState, directory] = await Promise.all([
      api("/api/auth/me", { cache: "no-store" }),
      api("/api/auth/accounts", { cache: "no-store" }),
    ]);
    me = accountState;
    at("identity").textContent = `Signed in as ${me.account.displayName || me.account.username} (${me.account.username})`;
    at("bootstrap").hidden = !me.bootstrap;
    at("register").textContent = me.passkeys.length ? "Add a passkey" : "Create your first passkey";
    at("keys").replaceChildren(...me.passkeys.map((key) => row(
      key.name || "Passkey", `Added ${dateLabel(key.createdAt)} · Last used ${dateLabel(key.lastUsedAt)}`,
      "Remove", () => run(async () => {
        if (!await confirm({ title: "Remove passkey?", body: `Remove “${key.name || "Passkey"}” from your account?`, confirmLabel: "Remove", danger: true })) return;
        await freshAdminAuth();
        await api(`/api/auth/passkeys/${encodeURIComponent(key.id)}`, { method: "DELETE" });
        await refresh();
        message("Passkey removed.");
      }), me.passkeys.length <= 1,
    )));
    if (!me.passkeys.length) at("keys").append(row("No passkeys yet", "Create your first passkey above to finish setup."));
    at("accounts").replaceChildren(...directory.accounts.map((account) => {
      const item = row(
      `${account.displayName || account.username} (${account.username})${account.id === me.account.id ? " · you" : ""}`,
      `${account.enabled ? "Enabled" : "Disabled"} · ${account.passkeyCount} passkey${account.passkeyCount === 1 ? "" : "s"}`,
      account.enabled ? "Disable" : "Enable", account.id === me.account.id ? null : () => run(async () => {
        const enabled = !account.enabled;
        if (!await confirm({ title: `${enabled ? "Enable" : "Disable"} admin account?`, body: `${enabled ? "Allow" : "Revoke"} dashboard access for ${account.username}?`, confirmLabel: enabled ? "Enable" : "Disable", danger: !enabled })) return;
        await freshAdminAuth();
        await api(`/api/auth/accounts/${encodeURIComponent(account.id)}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
        await refresh();
        message(`Admin account ${enabled ? "enabled" : "disabled"}.`);
      }), Boolean(me.bootstrap),
      );
      if (account.enabled && !account.passkeyCount && !me.bootstrap) {
        const inviteButton = document.createElement("button");
        inviteButton.type = "button";
        inviteButton.className = "ghost";
        inviteButton.textContent = "New setup link";
        inviteButton.addEventListener("click", () => run(async () => {
          at("invite-url").value = "";
          at("invite").hidden = true;
          await freshAdminAuth();
          const result = await api(`/api/auth/accounts/${encodeURIComponent(account.id)}/invite`, { method: "POST", body: "{}" });
          showInvite(result.setupUrl);
          message(`New private setup link for ${account.username}. Previous setup links are revoked.`);
        }));
        item.append(inviteButton);
      }
      return item;
    }));
    at("reauth").disabled = Boolean(me.bootstrap);
    at("reauth").dataset.unavailable = String(Boolean(me.bootstrap));
    for (const control of at("account-form").elements) {
      control.disabled = Boolean(me.bootstrap);
      control.dataset.unavailable = String(Boolean(me.bootstrap));
    }
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    message("");
    for (const button of container.querySelectorAll("button")) button.disabled = true;
    try { await action(); }
    catch (error) { message(passkeys().errorMessage(error), true); }
    finally {
      busy = false;
      for (const button of container.querySelectorAll("button")) button.disabled = button.dataset.unavailable === "true";
    }
  }

  at("register-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void run(async () => {
      if (!me.bootstrap) await freshAdminAuth();
      const { options } = await api("/api/auth/register/options", { method: "POST", body: "{}" });
      const response = await passkeys().create(options);
      await api("/api/auth/register/verify", { method: "POST", body: JSON.stringify({ response, name: at("key-name").value.trim() }) });
      at("key-name").value = "";
      await refresh();
      message("Passkey added. You can use it the next time you sign in.");
    });
  });
  at("reauth").addEventListener("click", () => run(async () => {
    await freshAdminAuth({ force: true });
    message("Identity verified. Sensitive actions are available for a short time.");
  }));
  at("account-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void run(async () => {
      // Retain at most the newest link, only in this page's DOM. It is never persisted.
      at("invite-url").value = "";
      at("invite").hidden = true;
      await freshAdminAuth();
      const result = await api("/api/auth/accounts", { method: "POST", body: JSON.stringify({ username: at("account-username").value.trim(), displayName: at("account-name").value.trim() }) });
      showInvite(result.setupUrl);
      at("account-form").reset();
      await refresh();
      message("Admin account created. Share the private setup link with that person.");
    });
  });
  at("copy").addEventListener("click", () => run(async () => {
    try {
      await navigator.clipboard.writeText(at("invite-url").value);
      message("Setup link copied. Share it privately with the intended admin.");
    } catch {
      at("invite-url").focus();
      at("invite-url").select();
      message("Select and copy the setup link above.");
    }
  }));
  at("dismiss").addEventListener("click", () => { at("invite-url").value = ""; at("invite").hidden = true; });
  try { await refresh(); }
  catch (error) { message(passkeys().errorMessage(error), true); }
}
