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

function accessRow(title, detail, actionLabel, action, disabled = false) {
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
    button.textContent = actionLabel;
    button.disabled = disabled;
    button.dataset.unavailable = String(disabled);
    button.addEventListener("click", action);
    item.append(button);
  }
  return item;
}

export async function mountAdminAccess(container, { confirm = async () => false, onLinked = null } = {}) {
  if (!container) return;
  const generation = Symbol("admin-access-mount");
  container._adminAccessMount = generation;
  const active = () => container._adminAccessMount === generation;
  container.innerHTML = `
    <h4>Your dashboard access</h4>
    <p class="desc">Dashboard access belongs to existing gateway admin users. Manage other admins from Users. Changes here save immediately.</p>
    <p class="admin-access-identity" data-access="identity">Loading your identity…</p>
    <div data-access="link-panel" hidden>
      <p class="admin-access-bootstrap">Link these passkeys to your existing gateway admin identity. We will send a verification code in a private chat message to that user.</p>
      <form class="admin-access-form" data-access="link-send-form">
        <label class="field"><span>Your gateway admin user</span><select data-access="link-user" required></select></label>
        <button type="submit" data-access="link-send">Send verification code</button>
      </form>
      <form class="admin-access-form" data-access="link-verify-form" hidden>
        <label class="field"><span>Code from your private chat message</span><input data-access="link-code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{8}" minlength="8" maxlength="8" required /></label>
        <button type="submit" data-access="link-verify">Verify and link</button>
      </form>
      <p class="desc" data-access="link-status"></p>
    </div>
    <p class="admin-access-bootstrap" data-access="bootstrap" hidden>Create your first passkey to finish setup. The existing admin password stops working after enrollment.</p>
    <form data-access="register-form" class="admin-access-form">
      <label class="field"><span>Passkey name</span><input data-access="key-name" type="text" autocomplete="off" placeholder="For example, work laptop or spare key" required maxlength="100" /></label>
      <button type="submit" data-access="register">Add a passkey</button>
    </form>
    <p class="desc">Register a spare passkey so you can still sign in if you lose your primary device. Your last passkey cannot be removed here.</p>
    <ul class="admin-access-list" data-access="keys" aria-label="Your passkeys"></ul>
    <button type="button" class="ghost" data-access="reauth">Verify identity</button>
    <p class="admin-access-message" data-access="message" role="status" aria-live="polite"></p>`;
  const at = (name) => container.querySelector(`[data-access="${name}"]`);
  let me;
  let busy = false;
  let ready = false;
  let linkRequestId = "";
  function syncControls() {
    if (!active()) return;
    for (const control of container.querySelectorAll("button, select")) control.disabled = !ready || busy || control.dataset.unavailable === "true";
  }
  syncControls();
  function message(text, error = false) {
    if (!active()) return;
    at("message").textContent = text;
    at("message").classList.toggle("error", error);
  }
  async function run(action) {
    if (!ready || busy || !active()) return;
    busy = true;
    message("");
    syncControls();
    try { await action(); }
    catch (error) { message(passkeys().errorMessage(error), true); }
    finally {
      busy = false;
      syncControls();
    }
  }
  async function refresh() {
    const accountState = await api("/api/auth/me", { cache: "no-store" });
    if (!active()) return;
    me = accountState;
    at("identity").textContent = me.account.userId
      ? `Signed in as ${me.account.displayName || me.account.username} · ${me.account.userId}`
      : "Your current passkeys are not yet linked to a gateway user.";
    at("link-panel").hidden = !(me.canLink || me.linkRequired);
    if (me.canLink || me.linkRequired) {
      const selectedUser = at("link-user").value;
      const { users } = await api("/api/auth/link/users", { cache: "no-store" });
      if (!active()) return;
      at("link-user").replaceChildren(...users.map((user) => {
        const option = document.createElement("option");
        option.value = user.id;
        option.textContent = `${user.name || user.id} (${user.id})`;
        return option;
      }));
      if (users.some((user) => user.id === selectedUser)) at("link-user").value = selectedUser;
      at("link-send").dataset.unavailable = String(!users.length);
      if (!users.length) at("link-status").textContent = "No existing admin user is available to link. Configure your chat connection and admin users first.";
    }
    at("bootstrap").hidden = !me.bootstrap;
    at("register").textContent = me.passkeys.length ? "Add a passkey" : "Create your first passkey";
    at("register").dataset.unavailable = String(Boolean(me.linkRequired));
    at("keys").replaceChildren(...me.passkeys.map((key) => accessRow(
      key.name || "Passkey", `Added ${dateLabel(key.createdAt)} · Last used ${dateLabel(key.lastUsedAt)}`,
      "Remove", () => run(async () => {
        if (!await confirm({ title: "Remove passkey?", body: `Remove “${key.name || "Passkey"}” from your identity?`, confirmLabel: "Remove", danger: true })) return;
        await freshAdminAuth();
        await api(`/api/auth/passkeys/${encodeURIComponent(key.id)}`, { method: "DELETE" });
        await refresh();
        message("Passkey removed.");
      }), me.passkeys.length <= 1 || me.linkRequired,
    )));
    if (!me.passkeys.length) at("keys").append(accessRow("No passkeys yet", me.linkRequired ? "Verify your gateway user above before creating the first passkey." : "Create your first passkey above to finish setup."));
    at("reauth").dataset.unavailable = String(Boolean(me.bootstrap));
    syncControls();
  }
  at("link-send-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void run(async () => {
      if (!me.bootstrap) await freshAdminAuth();
      const result = await api("/api/auth/link/options", { method: "POST", body: JSON.stringify({ userId: at("link-user").value }) });
      linkRequestId = result.requestId;
      at("link-code").value = "";
      at("link-verify-form").hidden = false;
      at("link-status").textContent = "Check the selected user's private chat messages for an 8-digit code. It expires in 5 minutes.";
      at("link-code").focus();
    });
  });
  at("link-verify-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void run(async () => {
      await api("/api/auth/link/verify", { method: "POST", body: JSON.stringify({ requestId: linkRequestId, code: at("link-code").value.trim() }) });
      linkRequestId = "";
      at("link-code").value = "";
      await refresh();
      message("Your passkeys are now linked to your gateway admin user.");
      if (onLinked) await onLinked();
    });
  });
  at("link-user").addEventListener("change", () => {
    linkRequestId = "";
    at("link-code").value = "";
    at("link-verify-form").hidden = true;
    at("link-status").textContent = "Send a new verification code to the selected user.";
  });
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
    await refresh();
    message("Identity verified. Sensitive actions are available for a short time.");
  }));
  try { await refresh(); if (active()) ready = true; }
  catch (error) { message(passkeys().errorMessage(error), true); }
  finally { syncControls(); }
}

export async function mountUserDashboardAccess(container, userId, { confirm = async () => false } = {}) {
  if (!container) return;
  container.innerHTML = `
    <h4>Dashboard access</h4>
    <p class="desc" data-dashboard="status">Loading passkey status…</p>
    <ul class="admin-access-list" data-dashboard="keys" aria-label="User's passkeys"></ul>
    <div class="admin-access-actions">
      <button type="button" data-dashboard="invite" hidden>Invite to dashboard</button>
      <button type="button" class="ghost" data-dashboard="revoke" hidden>Sign out dashboard sessions</button>
    </div>
    <div class="admin-access-invite" data-dashboard="invite-panel" hidden>
      <p class="desc">Share this single-use setup link privately with this user. It expires in 15 minutes and is only kept on this page.</p>
      <label class="field"><span>Private setup link</span><input data-dashboard="invite-url" type="text" readonly autocomplete="off" /></label>
      <button type="button" class="ghost" data-dashboard="copy">Copy setup link</button>
      <button type="button" class="ghost" data-dashboard="dismiss">Dismiss link</button>
    </div>
    <p class="admin-access-message" data-dashboard="message" role="status" aria-live="polite"></p>`;
  const at = (name) => container.querySelector(`[data-dashboard="${name}"]`);
  let busy = false;
  const message = (text, error = false) => {
    at("message").textContent = text;
    at("message").classList.toggle("error", error);
  };
  const refresh = async () => {
    const [state, actor] = await Promise.all([
      api(`/api/auth/users/${encodeURIComponent(userId)}`, { cache: "no-store" }),
      api("/api/auth/me", { cache: "no-store" }),
    ]);
    at("status").textContent = !state.isAdmin
      ? "Only gateway admin users can sign in to the dashboard. Save the Admin role above before inviting this user."
      : state.passkeyCount ? `${state.passkeyCount} registered passkey${state.passkeyCount === 1 ? "" : "s"}. Dashboard access follows this user's Admin role.`
        : "This admin has not registered a passkey yet. Send a private setup link to invite them to the dashboard.";
    const canInvite = state.canInvite && Boolean(actor.account.userId) && !actor.bootstrap;
    at("invite").hidden = !state.isAdmin || state.passkeyCount > 0;
    at("invite").disabled = !canInvite;
    at("invite").dataset.unavailable = String(!canInvite);
    at("invite").textContent = state.linked ? "Create new setup link" : "Invite to dashboard";
    at("revoke").hidden = !state.isAdmin || !state.linked;
    at("keys").replaceChildren(...state.passkeys.map((key) => accessRow(key.name || "Passkey", `Added ${dateLabel(key.createdAt)} · Last used ${dateLabel(key.lastUsedAt)}`)));
    if (state.isAdmin && !actor.account.userId) at("status").textContent += " Link your own admin identity under Settings → Admin access before inviting users.";
  };
  const run = async (action) => {
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
  };
  at("invite").addEventListener("click", () => run(async () => {
    at("invite-url").value = "";
    at("invite-panel").hidden = true;
    await freshAdminAuth();
    const { setupUrl } = await api(`/api/auth/users/${encodeURIComponent(userId)}/invite`, { method: "POST", body: "{}" });
    at("invite-url").value = setupUrl;
    at("invite-panel").hidden = false;
    message("Setup link created. Share it privately with this user.");
  }));
  at("revoke").addEventListener("click", () => run(async () => {
    if (!await confirm({ title: "Sign out dashboard sessions?", body: "This user will need a passkey to sign in again. Registered passkeys are kept.", confirmLabel: "Sign out", danger: true })) return;
    await freshAdminAuth();
    await api(`/api/auth/users/${encodeURIComponent(userId)}/revoke-sessions`, { method: "POST", body: "{}" });
    message("Dashboard sessions signed out.");
  }));
  at("copy").addEventListener("click", () => run(async () => {
    try { await navigator.clipboard.writeText(at("invite-url").value); message("Setup link copied. Share it privately with this user."); }
    catch { at("invite-url").focus(); at("invite-url").select(); message("Select and copy the setup link above."); }
  }));
  at("dismiss").addEventListener("click", () => { at("invite-url").value = ""; at("invite-panel").hidden = true; });
  try { await refresh(); }
  catch (error) { message(passkeys().errorMessage(error), true); }
}
