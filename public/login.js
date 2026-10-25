// Setup links are credentials. Capture the token only in this closure and immediately remove
// it from the address bar/history before making requests or waiting for user interaction.
(() => {
  const address = new URL(location.href);
  const fragment = new URLSearchParams(address.hash.slice(1));
  let setupToken = fragment.get("setup") || "";
  if (fragment.has("setup")) {
    address.hash = "";
    history.replaceState(history.state, "", address.pathname + address.search + address.hash);
  }
  const byId = (id) => document.getElementById(id);
  const passkeys = window.ChannelGatePasskeys;
  let busy = false;
  let linkRequestId = "";

  async function request(url, body) {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "X-CG-Request": "1" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Sign-in failed. Please try again.");
    return result;
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    byId("err").textContent = "";
    for (const control of document.querySelectorAll("button, select")) control.disabled = true;
    try { await action(); }
    catch (error) { byId("err").textContent = passkeys.errorMessage(error); byId("status").textContent = ""; }
    finally {
      busy = false;
      for (const control of document.querySelectorAll("button, select")) control.disabled = control.dataset.unavailable === "true";
    }
  }

  function showEnrollment(message) {
    byId("f").hidden = true;
    byId("bootstrap").hidden = true;
    byId("link-panel").hidden = true;
    byId("enroll-form").hidden = false;
    byId("intro").textContent = message;
    byId("status").textContent = "";
    byId("passkey-name").focus();
    byId("setup-restart").hidden = Boolean(setupToken);
  }

  async function resumeSetup() {
    const me = await request("/api/auth/me");
    byId("setup-restart").hidden = false;
    if (!me.linkRequired) {
      if (me.bootstrap || !me.passkeys.length) return showEnrollment("Complete setup: create your first passkey.");
      return void location.replace("/settings#set-admin-access");
    }
    byId("f").hidden = true;
    byId("bootstrap").hidden = true;
    byId("enroll-form").hidden = true;
    byId("link-panel").hidden = false;
    byId("intro").textContent = me.bootstrap ? "Verify your existing gateway admin user before creating a passkey." : "Link your passkeys to your existing gateway admin user.";
    byId("status").textContent = "";
    const { users } = await request("/api/auth/link/users");
    byId("link-user").replaceChildren(...users.map((user) => {
      const option = document.createElement("option");
      option.value = user.id;
      option.textContent = `${user.name || user.id} (${user.id})`;
      return option;
    }));
    byId("link-status").textContent = users.length
      ? "Select your own admin user. A verification code will be sent to that user's private chat messages."
      : "No eligible admin user is available. Ask the gateway operator to check the existing admin users and chat connection.";
    byId("link-send").dataset.unavailable = String(!users.length);
  }

  byId("link-send-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void run(async () => {
      const me = await request("/api/auth/me");
      if (!me.bootstrap && !me.fresh) {
        const { options } = await request("/api/auth/reauth/options", {});
        const response = await passkeys.get(options);
        await request("/api/auth/reauth/verify", { response });
      }
      const result = await request("/api/auth/link/options", { userId: byId("link-user").value });
      linkRequestId = result.requestId;
      byId("link-code").value = "";
      byId("link-verify-form").hidden = false;
      byId("link-status").textContent = "Check the selected user's private chat messages for an 8-digit code. It expires in 5 minutes.";
      byId("link-code").focus();
    });
  });
  byId("link-verify-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void run(async () => {
      await request("/api/auth/link/verify", { requestId: linkRequestId, code: byId("link-code").value.trim() });
      linkRequestId = "";
      byId("link-code").value = "";
      await resumeSetup();
    });
  });
  byId("link-user").addEventListener("change", () => {
    linkRequestId = "";
    byId("link-code").value = "";
    byId("link-verify-form").hidden = true;
    byId("link-status").textContent = "Send a new verification code to the selected user.";
  });
  byId("setup-restart").addEventListener("click", () => run(async () => {
    await request("/api/logout", {});
    location.replace("/login.html");
  }));

  byId("f").addEventListener("submit", (event) => {
    event.preventDefault();
    void run(async () => {
      byId("status").textContent = "Choose a passkey and verify with your screen lock or security key…";
      const { options } = await request("/api/auth/login/options", {});
      const response = await passkeys.get(options);
      await request("/api/auth/login/verify", { response });
      const me = await request("/api/auth/me");
      if (me.linkRequired) await resumeSetup();
      else location.replace("/");
    });
  });

  byId("bootstrap-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void run(async () => {
      try {
        await request("/api/login", { username: "admin", password: byId("pw").value });
      } finally { byId("pw").value = ""; }
      await resumeSetup();
    });
  });

  byId("enroll-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void run(async () => {
      byId("status").textContent = "Follow your browser's prompt to create a passkey…";
      const invited = Boolean(setupToken);
      const { options } = await request(invited ? "/api/auth/enroll/options" : "/api/auth/register/options", invited ? { token: setupToken } : {});
      const response = await passkeys.create(options);
      await request(invited ? "/api/auth/enroll/verify" : "/api/auth/register/verify", { response, name: byId("passkey-name").value.trim() });
      setupToken = "";
      location.replace("/settings#set-admin-access");
    });
  });

  if (setupToken) {
    showEnrollment("Set up your admin account by creating a passkey.");
  } else {
    void run(async () => {
      const status = await request("/api/auth/status");
      byId("bootstrap").hidden = !status.bootstrapAvailable;
      // Refreshing during first-time setup resumes the limited bootstrap session.
      if (status.bootstrapAvailable) {
        const me = await request("/api/auth/me").catch(() => null);
        if (me?.bootstrap) await resumeSetup();
      }
    });
  }
  if (!passkeys.available()) byId("err").textContent = "Passkeys need a supported browser and a secure HTTPS connection (or localhost).";
})();
