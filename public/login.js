// Sign-in form handler for login.html. Kept out of the page so the admin UI can be served with a
// Content-Security-Policy that admits no inline script.
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("err");
  err.textContent = "";
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: document.getElementById("pw").value }),
  });
  if (res.ok) return void (location.href = "/");
  // A 403 here means no admin password is configured at all — show what the server says to
  // do about it rather than the misleading "Wrong password."
  const body = await res.json().catch(() => ({}));
  err.textContent = body.error || "Wrong password.";
});
