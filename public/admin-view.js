import { api } from "./admin-api.js";

export const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function openDialog({ title, body, confirmLabel, cancelLabel, danger, confirmOnly, password = false, alternativeLabel = "", alternativeDanger = false }) {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirm-modal");
    const titleEl = document.getElementById("confirm-title");
    const bodyEl = document.getElementById("confirm-body");
    const okBtn = document.getElementById("confirm-ok");
    const cancelBtn = document.getElementById("confirm-cancel");
    const alternativeBtn = document.getElementById("confirm-alternative");
    const passwordField = document.getElementById("confirm-password-field");
    const passwordInput = document.getElementById("confirm-password");
    const previousFocus = document.activeElement;
    passwordField.hidden = !password;
    passwordInput.value = "";
    titleEl.textContent = title || "Are you sure?";
    bodyEl.textContent = body || "";
    bodyEl.style.display = body ? "" : "none";
    okBtn.textContent = confirmLabel || (confirmOnly ? "OK" : "Confirm");
    okBtn.classList.toggle("danger-btn", !!danger);
    cancelBtn.textContent = cancelLabel || "Cancel";
    cancelBtn.hidden = !!confirmOnly;
    alternativeBtn.hidden = !alternativeLabel;
    alternativeBtn.textContent = alternativeLabel;
    alternativeBtn.classList.toggle("danger-btn", !!alternativeDanger);
    modal.hidden = false;
    const done = (value) => {
      modal.hidden = true;
      passwordInput.value = "";
      passwordField.hidden = true;
      previousFocus?.focus?.();
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      alternativeBtn.removeEventListener("click", onAlternative);
      alternativeBtn.hidden = true;
      modal.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onOk = () => {
      if (password && !passwordInput.value) { passwordInput.focus(); return; }
      done(password ? passwordInput.value : true);
    };
    const onCancel = () => done(password ? "" : false);
    const onAlternative = () => done("alternative");
    const onBackdrop = (event) => { if (event.target === modal) onCancel(); };
    const onKey = (event) => {
      if (event.key === "Escape") onCancel();
      else if (event.key === "Enter") {
        event.preventDefault();
        if (document.activeElement === alternativeBtn && alternativeLabel) onAlternative();
        else if (document.activeElement === cancelBtn && !confirmOnly) onCancel();
        else onOk();
      }
      else if (event.key === "Tab") {
        const controls = [password ? passwordInput : null, confirmOnly ? null : cancelBtn, alternativeLabel ? alternativeBtn : null, okBtn].filter(Boolean);
        const current = controls.indexOf(document.activeElement);
        const next = (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
        event.preventDefault();
        controls[next].focus();
      }
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    alternativeBtn.addEventListener("click", onAlternative);
    modal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    (password ? passwordInput : okBtn).focus();
  });
}

export const confirmDialog = (options = {}) => openDialog(options);
export const infoDialog = (options = {}) => openDialog({ ...options, confirmOnly: true });
export const passwordDialog = (options = {}) => openDialog({ title: "Current admin password", confirmLabel: "Continue", ...options, password: true });

const ICON_EYE = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8Z"/><circle cx="8" cy="8" r="2"/></svg>`;
const ICON_EYE_OFF = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6.4 3.7A6.7 6.7 0 0 1 8 3.5c4.5 0 7 4.5 7 4.5a12.4 12.4 0 0 1-2 2.5M3.4 4.8A12.4 12.4 0 0 0 1 8s2.5 4.5 7 4.5a6.7 6.7 0 0 0 2.5-.5M2 2l12 12"/></svg>`;

let revealPassword = "";
let revealPasswordAt = 0;
const REVEAL_PW_TTL_MS = 5 * 60 * 1000;

async function askRevealPassword() {
  if (revealPassword && Date.now() - revealPasswordAt < REVEAL_PW_TTL_MS) return revealPassword;
  const password = await passwordDialog({ body: "Enter your current admin password to reveal this secret." });
  if (!password) return "";
  revealPassword = password;
  revealPasswordAt = Date.now();
  return password;
}

export function revealSecret(scope, field, id = "") {
  return async () => {
    const password = await askRevealPassword();
    if (!password) return "";
    try {
      const { value } = await api("/api/secrets/reveal", { method: "POST", body: JSON.stringify({ scope, field, id, password }) });
      return value || "";
    } catch (error) {
      if (/password/i.test(error.message)) { revealPassword = ""; revealPasswordAt = 0; }
      throw error;
    }
  };
}

function maskToken(token) {
  const value = String(token || "");
  if (!value) return "";
  if (value.length <= 6) return "•".repeat(value.length);
  const dots = Math.min(12, Math.max(4, value.length - 7));
  return value.slice(0, 3) + "•".repeat(dots) + value.slice(-4);
}

const maskFromLast4 = (last4) => `${"•".repeat(8)}${last4 || ""}`;

export function paintReveal(input) {
  const control = input._reveal;
  if (!control) return;
  if (control.dirty) input.type = control.revealed ? "text" : "password";
  else if (control.has) {
    input.type = "text";
    input.value = control.revealed && control.full ? control.full : control.full ? maskToken(control.full) : maskFromLast4(control.last4);
  } else {
    input.type = control.revealed ? "text" : "password";
    input.value = "";
  }
  if (control.btn) {
    control.btn.innerHTML = control.revealed ? ICON_EYE_OFF : ICON_EYE;
    control.btn.title = control.revealed ? "Hide" : "Reveal";
    control.btn.setAttribute("aria-label", control.btn.title);
  }
}

export function attachReveal(input, spec) {
  const previous = input._reveal;
  const data = typeof spec === "string" || spec == null
    ? { has: Boolean(spec), last4: spec ? String(spec).slice(-4) : "", full: String(spec || ""), fetch: null }
    : { has: Boolean(spec.has), last4: spec.last4 || "", full: "", fetch: spec.fetch || null };
  input._reveal = { ...data, dirty: false, revealed: false, btn: previous?.btn || null };
  input.dataset.dirty = "";
  if (!previous) {
    const wrap = document.createElement("span");
    wrap.className = "reveal-wrap";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "reveal-btn";
    button.tabIndex = -1;
    button.addEventListener("click", async () => {
      const control = input._reveal;
      if (!control.revealed && control.has && !control.full && control.fetch) {
        button.disabled = true;
        try { control.full = await control.fetch(); }
        catch (error) {
          if (error?.message) await openDialog({ title: "Couldn't reveal", body: error.message, confirmOnly: true, confirmLabel: "OK" });
          button.disabled = false;
          return;
        }
        button.disabled = false;
        if (!control.full) return;
      }
      control.revealed = !control.revealed;
      paintReveal(input);
    });
    wrap.appendChild(button);
    input._reveal.btn = button;
    input.addEventListener("focus", () => { const control = input._reveal; if (!control.dirty && control.full && !control.revealed) input.select(); });
    input.addEventListener("input", () => { const control = input._reveal; if (!control.dirty) { control.dirty = true; input.dataset.dirty = "1"; } input.type = control.revealed ? "text" : "password"; });
    input.addEventListener("blur", () => { const control = input._reveal; if (control.dirty && !input.value.trim()) { control.dirty = false; input.dataset.dirty = ""; paintReveal(input); } });
  }
  paintReveal(input);
  return input._reveal;
}

export function tokenValue(input) {
  const control = input._reveal;
  return control && control.dirty && input.value.trim() ? input.value.trim() : "";
}
