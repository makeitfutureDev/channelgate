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
    for (const button of document.querySelectorAll("button")) button.disabled = true;
    try { await action(); }
    catch (error) { byId("err").textContent = passkeys.errorMessage(error); byId("status").textContent = ""; }
    finally {
      busy = false;
      for (const button of document.querySelectorAll("button")) button.disabled = false;
    }
  }

  function showEnrollment(message) {
    byId("f").hidden = true;
    byId("bootstrap").hidden = true;
    byId("enroll-form").hidden = false;
    byId("intro").textContent = message;
    byId("status").textContent = "";
    byId("passkey-name").focus();
  }

  byId("f").addEventListener("submit", (event) => {
    event.preventDefault();
    void run(async () => {
      byId("status").textContent = "Choose a passkey and verify with your screen lock or security key…";
      const { options } = await request("/api/auth/login/options", {});
      const response = await passkeys.get(options);
      await request("/api/auth/login/verify", { response });
      location.replace("/");
    });
  });

  byId("bootstrap-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void run(async () => {
      try {
        await request("/api/login", { username: "admin", password: byId("pw").value });
      } finally { byId("pw").value = ""; }
      showEnrollment("Complete setup: create the first passkey for admin.");
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
        if (me?.bootstrap) showEnrollment("Complete setup: create the first passkey for admin.");
      }
    });
  }
  if (!passkeys.available()) byId("err").textContent = "Passkeys need a supported browser and a secure HTTPS connection (or localhost).";
})();
