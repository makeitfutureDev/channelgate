// Engine licenses in the admin UI.
//
// There are two HARNESSES (Claude Code, Codex) and every engine id is a LICENSE of one of them
// (src/engines/license-state.js). This module holds the two things the admin UI needs for that:
//
//   1. The one picker shape every engine choice uses — harness → license → "if it fails, also
//      use" — as pure functions mirroring src/gateway/license-pool.js, plus the control that draws
//      them. app.js mounts it for the gateway default, a channel, a DM and the templates.
//   2. The licenses manager on the Settings page (src/web/routes/licenses.js).
//
// No imports on purpose: the pure half runs under plain Node in the tests, and the DOM half is
// handed what it needs (api, confirm, the shared Codex sign-in box) by app.js.
//
// "License" here is an ENGINE license. The ChannelGate product license is a different thing with
// its own page and its own endpoint (/api/license).

export const LICENSE_POOL_ANY = "any";
export const harnessPolicyEntry = (harness) => `harness:${harness}`;

const list = (value) => (Array.isArray(value) ? value : []);
const manifestOf = (env, id) => list(env?.manifests).find((m) => m.id === id) || null;

// The manifest (/api/settings → engines) says which harness a license belongs to and what it is
// called inside that harness's picker. Never inferred from the id.
export const harnessOf = (manifest) => String(manifest?.harness || manifest?.cli || manifest?.id || "");
export const licenseLabelOf = (manifest) => String(manifest?.licenseLabel || manifest?.label || manifest?.id || "");

// The harnesses the manifest knows, in manifest order: [{ id, label }].
export function harnessList(manifests) {
  const out = [];
  for (const m of list(manifests)) {
    const id = harnessOf(m);
    if (id && !out.some((h) => h.id === id)) out.push({ id, label: String(m.harnessLabel || id) });
  }
  return out;
}

export function harnessLabelOf(manifests, harness) {
  return harnessList(manifests).find((h) => h.id === harness)?.label || String(harness || "");
}

// Mirrors isChannelEngineApproved (src/gateway/channel-engines.js): null admits everything; a list
// admits a license it names, or every license of a harness it names as `harness:<id>`.
export function policyAdmits(policy, manifest) {
  if (policy == null) return true;
  if (!Array.isArray(policy) || !manifest) return false;
  return policy.includes(manifest.id) || policy.includes(harnessPolicyEntry(harnessOf(manifest)));
}

// `env` is where a picker stands: { manifests, enabled, codexAuthSource, policy }.
//   enabled          the engineEnabled map (a license missing from it counts as on)
//   codexAuthSource  "channel" when this conversation signed in its own Codex account
//   policy           the conversation's approvedEngines (null = no lock)
const usableHere = (env, m) => env?.enabled?.[m.id] !== false
  && (!m.channelScoped || env?.codexAuthSource === "channel")
  && policyAdmits(env?.policy, m);

// Every license of `harness` a conversation may run on: switched on, admitted by the lock, and
// available here (selectableLicenses on the server).
export function usableLicenses(env, harness) {
  return list(env?.manifests).filter((m) => harnessOf(m) === harness && usableHere(env, m)).map((m) => m.id);
}

export function selectableHarnesses(env) {
  return harnessList(env?.manifests).filter((h) => usableLicenses(env, h.id).length > 0);
}

// A picker is never blank: when the enable map switches everything off (or has not loaded) and no
// lock is in play, offer the whole manifest rather than nothing.
export function pickerEnv(env) {
  if (env?.policy != null || selectableHarnesses(env).length) return env;
  return { ...env, enabled: {} };
}

// The license a bare harness pick runs on: the harness's own sign-in when usable, else the first.
export function primaryLicense(env, harness) {
  const ids = usableLicenses(env, harness);
  return ids.includes(harness) ? harness : ids[0] || "";
}

// The license step for one harness (licensePicker on the server). `show` is false when there is
// nothing to choose between; `selected` is "any" or a license id; `also` the further licenses the
// stored selection moves to; `others` what "If it fails, also use" may offer beside `selected`.
export function licensePickerState(env, { harness, engine = "", pool = "" } = {}) {
  const ids = usableLicenses(env, harness);
  const onHarness = ids.includes(engine);
  const stored = !onHarness ? [] : pool === LICENSE_POOL_ANY ? LICENSE_POOL_ANY : list(pool);
  const selected = stored === LICENSE_POOL_ANY ? LICENSE_POOL_ANY : onHarness ? engine : primaryLicense(env, harness);
  const labelled = (id) => ({ id, label: licenseLabelOf(manifestOf(env, id)) });
  return {
    show: ids.length > 1,
    licenses: ids.map(labelled),
    selected,
    also: Array.isArray(stored) ? stored.filter((id, index) => id !== engine && ids.includes(id) && stored.indexOf(id) === index) : [],
    others: selected === LICENSE_POOL_ANY ? [] : ids.filter((id) => id !== selected).map(labelled),
  };
}

// A pick → the `engine` + pool every level stores (resolveLicensePick on the server). `license` is
// "any", a license id, or "" when no license control was shown.
export function resolveLicensePick(env, { harness, license = "", also = [] } = {}) {
  const ids = usableLicenses(env, harness);
  if (!ids.length) return { engine: "", licensePool: "" };
  if (!license || license === LICENSE_POOL_ANY || !ids.includes(license)) {
    return { engine: primaryLicense(env, harness), licensePool: license === LICENSE_POOL_ANY && ids.length > 1 ? LICENSE_POOL_ANY : "" };
  }
  const rest = [...new Set(list(also))].filter((id) => id !== license && ids.includes(id));
  return { engine: license, licensePool: rest.length ? rest : "" };
}

// One line for a summary: "Codex", "Codex · any license", "Codex · Work, then Second seat".
export function describeSelection(env, { engine = "", pool = "" } = {}) {
  const manifest = manifestOf(env, engine);
  if (!manifest) return "";
  const harness = harnessOf(manifest);
  const name = harnessLabelOf(env.manifests, harness);
  const picker = licensePickerState(env, { harness, engine, pool });
  if (!picker.show) return name;
  if (picker.selected === LICENSE_POOL_ANY) return `${name} · any license`;
  const then = picker.also.map((id) => licenseLabelOf(manifestOf(env, id)));
  return `${name} · ${licenseLabelOf(manifest)}${then.length ? `, then ${then.join(", ")}` : ""}`;
}

// What an engine id reads as on its own (an audit row, a status chip): the harness when it has one
// license, "<Harness> · <license>" otherwise. An id the manifest no longer knows stays as it is.
export function engineDisplayName(manifests, id) {
  const manifest = list(manifests).find((m) => m.id === id);
  if (!manifest) return String(id || "");
  const harness = harnessOf(manifest);
  if (list(manifests).filter((m) => harnessOf(m) === harness).length < 2) return harnessLabelOf(manifests, harness);
  // A harness's own sign-in reads as the harness until an administrator names it.
  return manifest.builtin === false || manifest.customName ? `${harnessLabelOf(manifests, harness)} · ${licenseLabelOf(manifest)}` : String(manifest.label || id);
}

// A one-control engine choice (a model shortcut row, a catalog view switch): one option per usable
// license, named by its harness alone when the harness has a single one.
export function engineChoices(env) {
  const e = pickerEnv(env);
  return selectableHarnesses(e).flatMap((h) => {
    const ids = usableLicenses(e, h.id);
    return ids.map((id) => ({ id, label: ids.length > 1 ? `${h.label} · ${licenseLabelOf(manifestOf(e, id))}` : h.label }));
  });
}

// The lock's options: per harness, the whole harness (`harness:<id>` — licenses added later
// included) and then each license on its own.
export function lockOptionGroups(manifests) {
  return harnessList(manifests).map((h) => ({
    harness: h.id,
    label: h.label,
    entry: harnessPolicyEntry(h.id),
    entryLabel: `${h.label} — any license`,
    licenses: list(manifests).filter((m) => harnessOf(m) === h.id).map((m) => ({ id: m.id, label: licenseLabelOf(m) })),
  }));
}

// What a checked set stores: a harness-wide entry covers its licenses, so those are not repeated.
export function lockValues(manifests, checked) {
  const picked = new Set(list(checked));
  return lockOptionGroups(manifests).flatMap((group) => picked.has(group.entry)
    ? [group.entry]
    : group.licenses.filter((license) => picked.has(license.id)).map((license) => license.id));
}

// Entries of a stored lock the manifest no longer knows (a removed license). They approve nothing.
export function unknownLockEntries(manifests, policy) {
  const known = new Set(lockOptionGroups(manifests).flatMap((group) => [group.entry, ...group.licenses.map((license) => license.id)]));
  return list(policy).filter((entry) => !known.has(entry));
}

// How a license's live status reads in the list. `license` is one entry of /api/engine-licenses.
export function licenseStatusBadge(license) {
  const status = license?.status || {};
  const detail = String(status.detail || "");
  if (status.ready) return { tone: "ok", text: "Ready", detail: status.plan?.detail && status.plan.matches === false ? String(status.plan.detail) : "" };
  const verification = license?.verification;
  if (verification && verification.verified && verification.ok === false) return { tone: "bad", text: "Key rejected", detail: String(verification.detail || detail) };
  if (status.signedIn === false) return { tone: "warn", text: "Not signed in", detail };
  if (status.plan && status.plan.matches === false) return { tone: "bad", text: "Plan mismatch", detail: String(status.plan.detail || detail) };
  return { tone: "warn", text: "Not ready", detail };
}

// The models box of the API form: one id per line, or comma-separated.
export function parseModelList(text) {
  return [...new Set(String(text || "").split(/[\n,]+/).map((id) => id.trim()).filter(Boolean))];
}

// ── The picker control ───────────────────────────────────────────────────────────────────────────
// Turns one <select> into the harness step and adds the license step after it:
//
//   Harness  →  License ("Any license" + each)  →  If it fails, also use  →  (model, effort)
//
// The license controls exist only when the harness has more than one usable license here. The
// returned handle reads like the engine <select> it replaces — `.value` is the engine id to store
// ("" = inherit) — and `.pool` is what goes beside it ("" | "any" | [ids]).
//
//   env()            where the picker stands (see usableLicenses); read again on every repaint
//   includeDefault   offer the empty "inherit" choice first
//   defaultAllowed() false while the inherited engine may not run here (a lock leaves it out):
//                    the choice stays visible, greyed
//   allowPool        false where only one license can be stored (the settings templates)
//   onChange(handle) after any of the three controls changed
export function mountLicensePicker({
  harnessSelect,
  after = null,
  env,
  engine = "",
  pool = "",
  includeDefault = false,
  defaultLabel = "Default (global setting)",
  defaultAllowed = () => true,
  allowPool = true,
  onChange = () => {},
}) {
  const doc = harnessSelect.ownerDocument;
  const make = (tag, className, text) => {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  };
  const option = (value, label) => { const el = make("option", "", label); el.value = value; return el; };

  const licenseField = make("label", "field lic-field");
  const licenseSelect = make("select", "lic-select");
  licenseSelect.setAttribute("aria-label", "License");
  licenseField.append(make("span", "", "License"), licenseSelect);
  const alsoField = make("div", "lic-also-field");
  alsoField.setAttribute("role", "group");
  alsoField.setAttribute("aria-label", "If it fails, also use");
  const alsoBox = make("div", "lic-also checks");
  alsoField.append(make("span", "lic-also-title", "If it fails, also use"), alsoBox, make("em", "state", "When a license cannot answer, the turn moves to the next one."));
  licenseField.hidden = true;
  alsoField.hidden = true;
  (after || harnessSelect.closest("label") || harnessSelect).after(licenseField, alsoField);

  // `intent` is what was stored or last chosen; `current` is what the controls show and a save
  // sends. They differ while the choice cannot be offered (its license was switched off, or a lock
  // being edited does not admit it yet) — the intent comes back when it can be again.
  let intent = { harness: "", engine: "", pool: "" };
  let current = { harness: "", engine: "", licensePool: "" };
  const intend = (id, nextPool) => {
    const manifest = manifestOf(env(), id);
    intent = { harness: manifest ? harnessOf(manifest) : "", engine: manifest ? id : "", pool: manifest ? nextPool || "" : "" };
  };

  const paint = () => {
    const e = pickerEnv(env());
    const harnesses = selectableHarnesses(e);
    const inherit = includeDefault ? option("", defaultLabel) : null;
    if (inherit) inherit.disabled = !defaultAllowed();
    harnessSelect.replaceChildren(...(inherit ? [inherit] : []), ...harnesses.map((h) => option(h.id, h.label)));
    const harness = harnesses.some((h) => h.id === intent.harness) ? intent.harness : includeDefault ? "" : harnesses[0]?.id || "";
    harnessSelect.value = harness;
    if (!harness) {
      licenseField.hidden = true;
      alsoField.hidden = true;
      alsoBox.replaceChildren();
      current = { harness: "", engine: "", licensePool: "" };
      return;
    }
    const state = licensePickerState(e, { harness, engine: intent.engine, pool: allowPool ? intent.pool : "" });
    licenseField.hidden = !state.show;
    licenseSelect.replaceChildren(...(allowPool ? [option(LICENSE_POOL_ANY, "Any license")] : []), ...state.licenses.map((license) => option(license.id, license.label)));
    licenseSelect.value = state.selected;
    const others = allowPool && state.show ? state.others : [];
    alsoField.hidden = !others.length;
    alsoBox.replaceChildren(...others.map((license) => {
      const row = make("label");
      const input = make("input");
      input.type = "checkbox";
      input.value = license.id;
      input.checked = state.also.includes(license.id);
      row.append(input, " ", make("span", "", license.label));
      return row;
    }));
    current = { harness, ...resolveLicensePick(e, { harness, license: state.show ? state.selected : "", also: others.length ? state.also : [] }) };
  };

  const handle = {
    get value() { return current.engine; },
    get pool() { return current.licensePool; },
    get harness() { return current.harness; },
    set(nextEngine, nextPool = "") { intend(nextEngine, nextPool); paint(); },
    repaint: paint,
    harnessSelect,
    licenseSelect,
    licenseField,
    alsoField,
  };

  harnessSelect.addEventListener("change", () => {
    intent = { harness: harnessSelect.value, engine: "", pool: "" };
    paint();
    onChange(handle);
  });
  licenseSelect.addEventListener("change", () => {
    const picked = licenseSelect.value;
    intent = picked === LICENSE_POOL_ANY
      ? { harness: current.harness, engine: primaryLicense(pickerEnv(env()), current.harness), pool: LICENSE_POOL_ANY }
      : { harness: current.harness, engine: picked, pool: list(current.licensePool).filter((id) => id !== picked) };
    paint();
    onChange(handle);
  });
  // Not repainted: the box that was just ticked keeps the focus.
  alsoBox.addEventListener("change", (event) => {
    const input = event.target;
    if (!input || input.type !== "checkbox") return;
    const before = list(current.licensePool).filter((id) => id !== input.value);
    const next = input.checked ? [...before, input.value] : before;
    intent = { harness: current.harness, engine: current.engine, pool: next.length ? next : "" };
    current = { ...current, licensePool: next.length ? next : "" };
    onChange(handle);
  });

  intend(engine, pool);
  paint();
  return handle;
}

// ── The lock ─────────────────────────────────────────────────────────────────────────────────────
// "Approved harnesses" on a channel: per harness one "<Harness> — any license" box and one box per
// license. Ticking the harness-wide box greys its licenses — it already covers them, and the ones
// added later. A stored entry the manifest no longer knows is not drawn and not sent back.
export function mountLicenseLock(container, { manifests, policy = null } = {}) {
  const doc = container.ownerDocument;
  const stored = list(policy);
  const groups = lockOptionGroups(manifests);
  container.classList.toggle("empty", !groups.length);
  container.replaceChildren();
  const box = (value, label, className) => {
    const row = doc.createElement("label");
    if (className) row.className = className;
    const input = doc.createElement("input");
    input.type = "checkbox";
    input.value = value;
    input.checked = stored.includes(value);
    const text = doc.createElement("span");
    text.textContent = label;
    row.append(input, " ", text);
    return { row, input };
  };
  const wired = groups.map((group) => {
    const section = doc.createElement("div");
    section.className = "lic-lock-group";
    section.dataset.harness = group.harness;
    const whole = box(group.entry, group.entryLabel, "lic-lock-harness");
    const licenses = group.licenses.map((license) => box(license.id, license.label, "lic-lock-license"));
    section.append(whole.row, ...licenses.map((license) => license.row));
    container.append(section);
    return { whole, licenses };
  });
  const paint = () => {
    for (const { whole, licenses } of wired) {
      for (const license of licenses) {
        license.input.disabled = whole.input.checked;
        license.row.classList.toggle("covered", whole.input.checked);
      }
    }
  };
  container.addEventListener("change", paint);
  const unknown = unknownLockEntries(manifests, stored);
  if (!groups.length) container.textContent = "none available";
  else if (unknown.length) {
    const note = doc.createElement("em");
    note.className = "state lic-lock-unknown";
    note.textContent = `${unknown.length === 1 ? "One saved approval names a license" : `${unknown.length} saved approvals name licenses`} that no longer exist${unknown.length === 1 ? "s" : ""}. ${unknown.length === 1 ? "It approves" : "They approve"} nothing and ${unknown.length === 1 ? "is" : "are"} dropped when you save a change here.`;
    container.append(note);
  }
  paint();
  return {
    values: () => lockValues(manifests, [...container.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value)),
    unknown,
  };
}

// ── The licenses manager (Settings) ──────────────────────────────────────────────────────────────
// One group per harness — "Claude Code licenses", "Codex licenses" — listing every license of it:
// the ones the gateway ships with (from the manifest) and the ones an admin added (from
// /api/engine-licenses). The on/off switch is the page's own `engineEnabled` map and is saved by
// the page's Save; adding, editing, verifying and removing a license are requests of their own.
//
// A license's credential — an API key, or a Google service-account key file — is typed into a
// write-only box, sent once, and never read back: the listing carries `hasApiKey` + `apiKeyLast4`
// (or `hasServiceAccount` + the account's address) only, and nothing here writes one into the page.

// What each KIND of license (how it authenticates — not which engine it is) asks of the form. The
// catalog entry of the kind says it (`fields`, in order); nothing here knows a kind by name except
// the one sign-in that happens in the browser.
const kindTraits = (kind, catalog = null) => {
  const id = String(typeof kind === "string" ? kind : kind?.id || "");
  const entry = (typeof kind === "object" && kind) || list(catalog?.kinds).find((k) => k.id === id) || null;
  const fields = list(entry?.fields);
  return {
    fields,
    provider: Boolean(entry?.provider) || fields.length > 0, // typed credentials, checked against a server
    browserSignIn: id === "codex-login",                     // device code, through /api/engine-licenses/:id/login
  };
};
const AUTH_SCHEME_LABELS = { bearer: "Authorization: Bearer", "x-api-key": "x-api-key header", "api-key": "api-key header" };
// What a harness's own sign-in is called until an administrator names it (license-state.js).
export const DEFAULT_LICENSE_NAME = "Default sign-in";

// What removing a license the gateway ships with does, in the words of the confirmation. The
// manifest says what the license stores for itself (`ownCredential`); nothing is inferred from its id.
export function builtinRemovalText(manifest) {
  const base = "It is switched off and disappears from every picker. Channels and threads that selected it fall back to their defaults.";
  const credential = manifest?.ownCredential === "api-key" ? " Its stored API key and endpoint are deleted and cannot be recovered."
    : manifest?.ownCredential === "sign-in" ? " Its sign-in on the gateway host is deleted and cannot be recovered."
    : manifest?.channelScoped ? " Sign-ins that channels made for themselves are kept, but no channel can use them while this license is removed."
    : "";
  const after = manifest?.ownCredential ? " You can list it again later with Restore, but it has to be set up again." : " You can list it again later with Restore.";
  return `${base}${credential}${after}`;
}

// How each field reads for each provider. Wording only — which fields exist is the catalog's.
const FIELD_COPY = {
  baseUrl: {
    custom: ["Server address", "https only. The vendor's own API, or any compatible server."],
    azure: ["Azure endpoint", "Your resource's endpoint, https only."],
  },
  apiKey: {
    custom: ["API key or token"],
    bedrock: ["Bedrock API key", "A Bedrock API key from the AWS console — not an access key ID and secret."],
    azure: ["Azure API key"],
  },
  region: {
    bedrock: ["AWS region", "The region your Bedrock models are enabled in."],
    vertex: ["Location", "global, or a region such as europe-west1."],
  },
  projectId: { vertex: ["Google Cloud project ID", "Blank takes the project named in the key file."] },
  serviceAccount: { vertex: ["Service-account key (JSON)"] },
  apiVersion: { azure: ["API version", "Optional. Only for endpoints that require an api-version parameter."] },
  authScheme: { custom: ["How the key is sent"], azure: ["How the key is sent"] },
  models: { custom: ["Models"], bedrock: ["Models"], vertex: ["Models"], azure: ["Models / deployments"] },
};
const fieldCopy = (field, provider) => FIELD_COPY[field]?.[provider] || FIELD_COPY[field]?.custom || [field];

const CODEX_LOGIN_MARKUP = `
  <select class="ch-codex-login-method" hidden aria-hidden="true" tabindex="-1"><option value=""></option><option value="device">Sign in with ChatGPT</option><option value="api-key"></option></select>
  <div class="ch-codex-login-status state">Checking sign-in…</div>
  <div class="row-actions"><button type="button" class="ghost lic-signin-start">Sign in with ChatGPT</button><button type="button" class="ghost lic-signin-close">Close</button></div>
  <div class="ch-codex-device-section" hidden>
    <div class="ch-codex-device-code" hidden><a class="ch-codex-device-link" href="https://auth.openai.com/codex/device" target="_blank" rel="noopener noreferrer">Open ChatGPT sign-in</a><span> and enter code </span><button type="button" class="ch-codex-device-value" title="Copy sign-in code" aria-label="Copy sign-in code"></button><span class="ch-codex-copy-state state" role="status"></span></div>
    <button type="button" class="ghost ch-codex-device-cancel" hidden>Cancel sign-in</button>
  </div>
  <div class="ch-codex-api-section" hidden><input class="ch-codex-api-key" type="password" autocomplete="off" hidden><button type="button" class="ch-codex-key-save" hidden></button></div>
  <em class="state ch-codex-api-note" hidden></em>`;

export function mountLicensesManager({
  root,
  api,
  confirm,
  copyText,
  mountCodexLogin,
  state,
  health = () => null,
  setEnabled = () => {},
  builtinNote = () => "",
  openBuiltin = () => null,
  blocked = () => "",
  reload = async () => {},
}) {
  // root        where the groups are drawn
  // state()     { manifests, enabled } — the engine manifest and the engineEnabled map
  // health(id)  the health check of a license the gateway ships with (its status column)
  // setEnabled  a switch was flipped (the page's own Save stores it)
  // blocked()   a reason the page cannot be reloaded right now (unsaved edits), or ""
  // reload()    repaint Settings from the daemon and call load() again
  const doc = root.ownerDocument;
  const make = (tag, className, text) => {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  };
  const button = (label, className, onClick) => {
    const el = make("button", className, label);
    el.type = "button";
    el.addEventListener("click", onClick);
    return el;
  };
  const field = (label, control, help = "") => {
    const wrap = make("label", "field");
    wrap.append(make("span", "", label), control);
    if (help) wrap.append(make("em", "state", help));
    return wrap;
  };
  const option = (value, label) => { const el = make("option", "", label); el.value = value; return el; };

  let catalog = null;
  let licenses = [];
  let removed = []; // the shipped licenses an administrator removed: [{ id, harness, label }]
  let loadError = "";
  let loads = 0;
  // Panels that outlive a repaint: a form being typed into, a sign-in waiting on its code.
  let form = null;   // { harness, el }
  let panel = null;  // { id, el }
  const notices = new Map(); // harness → { text, bad }

  const say = (harness, text, bad = false) => { notices.set(harness, { text, bad }); };
  const recordOf = (id) => licenses.find((license) => license.id === id) || null;
  const closeForm = () => { form = null; };
  const closePanel = () => { panel = null; };

  // A change to the license list repaints the whole Settings form from the daemon, so it waits for
  // unsaved edits there instead of throwing them away.
  const refuseIfBlocked = (harness) => {
    const why = blocked();
    if (!why) return false;
    say(harness, why, true);
    paint();
    return true;
  };

  async function load() {
    const ticket = ++loads;
    try {
      const body = await api("/api/engine-licenses");
      if (ticket !== loads) return;
      catalog = body.catalog || null;
      licenses = list(body.licenses);
      removed = list(body.removed);
      loadError = "";
    } catch (error) {
      if (ticket !== loads) return;
      loadError = `The license list could not be loaded: ${error.message}`;
    }
    paint();
  }

  // After a request that changed a license: `reload()` repaints Settings from the daemon — the
  // manifest, so every picker — and loads this list again. With edits waiting on the page (or when
  // that reload fails) only the list is refreshed.
  const afterMutation = async () => {
    if (!blocked()) {
      try { await reload(); return; } catch { /* the list alone, below */ }
    }
    await load();
  };

  async function verify(license, harness) {
    say(harness, `Checking ${license.label}…`);
    paint();
    try {
      const result = await api(`/api/engine-licenses/${encodeURIComponent(license.id)}/verify`, { method: "POST" });
      const badge = licenseStatusBadge({ ...license, ...(result.license || {}), status: result.status || result.license?.status, verification: result.verification ?? result.license?.verification });
      say(harness, `${license.label}: ${badge.text}${result.verification?.detail || badge.detail ? ` — ${result.verification?.detail || badge.detail}` : ""}`, badge.tone === "bad");
    } catch (error) {
      say(harness, `${license.label} could not be checked: ${error.message}`, true);
    }
    await afterMutation();
  }

  async function remove(license, harness) {
    if (refuseIfBlocked(harness)) return;
    const ok = await confirm({
      title: `Remove the license "${license.label}"?`,
      body: "Channels and threads that selected this license fall back to their defaults. Its stored sign-in, API key or service-account key is deleted and cannot be recovered.",
      confirmLabel: "Remove license",
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/engine-licenses/${encodeURIComponent(license.id)}`, { method: "DELETE" });
      if (panel?.id === license.id) closePanel();
      if (form?.id === license.id) closeForm();
      say(harness, `Removed ${license.label}.`);
    } catch (error) {
      say(harness, `${license.label} could not be removed: ${error.message}`, true);
    }
    await afterMutation();
  }

  // A license the gateway ships with (a dedicated login, a provider) is removed rather than
  // deleted: switched off, unlisted, and what it stored for itself deleted. Restore lists it again.
  async function removeBuiltin(manifest, harness) {
    if (refuseIfBlocked(harness)) return;
    const name = licenseLabelOf(manifest);
    const ok = await confirm({
      title: `Remove the license "${name}"?`,
      body: builtinRemovalText(manifest),
      confirmLabel: "Remove license",
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/engine-licenses/${encodeURIComponent(manifest.id)}`, { method: "DELETE" });
      if (panel?.id === manifest.id) closePanel();
      if (form?.id === manifest.id) closeForm();
      say(harness, `Removed ${name}. It can be listed again with Restore.`);
    } catch (error) {
      say(harness, `${name} could not be removed: ${error.message}`, true);
    }
    await afterMutation();
  }

  async function restore(entry, harness) {
    if (refuseIfBlocked(harness)) return;
    try {
      await api(`/api/engine-licenses/${encodeURIComponent(entry.id)}/restore`, { method: "POST" });
      removed = removed.filter((other) => other.id !== entry.id);
      say(harness, `Restored ${entry.label}. It is switched off until you set it up and switch it on.`);
    } catch (error) {
      say(harness, `${entry.label} could not be restored: ${error.message}`, true);
    }
    await afterMutation();
  }

  // The harness's own sign-in has one editable fact: what every picker calls it.
  function openRename(manifest, harness) {
    if (refuseIfBlocked(harness)) return;
    closePanel();
    const el = make("div", "lic-form lic-rename");
    const nameInput = make("input");
    nameInput.type = "text";
    nameInput.maxLength = 60;
    nameInput.autocomplete = "off";
    nameInput.value = manifest.customName || "";
    nameInput.placeholder = DEFAULT_LICENSE_NAME;
    const formState = make("span", "state");
    formState.setAttribute("role", "status");
    const save = button("Save name", "primary lic-save", async () => {
      save.disabled = true;
      formState.textContent = "Saving…";
      try {
        const result = await api(`/api/engine-licenses/${encodeURIComponent(manifest.id)}`, { method: "PUT", body: JSON.stringify({ label: nameInput.value }) });
        say(harness, `${harnessLabelOf(state().manifests, harness)}'s own sign-in is now called "${result.license?.label || DEFAULT_LICENSE_NAME}".`);
        closeForm();
        await afterMutation();
      } catch (error) {
        save.disabled = false;
        formState.textContent = `✗ ${error.message}`;
      }
    });
    nameInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      save.click();
    });
    const actions = make("div", "row-actions");
    actions.append(save, button("Cancel", "ghost lic-cancel", () => { closeForm(); paint(); }), formState);
    el.append(
      make("strong", "", `Rename ${harnessLabelOf(state().manifests, harness)}'s own sign-in`),
      field("Name", nameInput, `How this license is listed in every picker. Leave it blank for "${DEFAULT_LICENSE_NAME}".`),
      actions,
    );
    form = { harness, id: manifest.id, el };
    paint();
    nameInput.focus();
    nameInput.select();
  }

  // The device-code sign-in of a Codex license: the same controls, and the same code path, as the
  // gateway's and a channel's own Codex login — only the URL differs.
  function openSignIn(license, harness) {
    const el = make("div", "ch-codex-login lic-panel");
    el.innerHTML = CODEX_LOGIN_MARKUP;
    const title = make("strong", "", `Sign in ${license.label}`);
    el.prepend(title);
    const method = el.querySelector(".ch-codex-login-method");
    el.querySelector(".lic-signin-start").addEventListener("click", () => {
      method.value = "device";
      method.dispatchEvent(new Event("change", { bubbles: false }));
    });
    el.querySelector(".lic-signin-close").addEventListener("click", () => { closePanel(); paint(); });
    panel = { id: license.id, el };
    paint();
    mountCodexLogin(el, `/api/engine-licenses/${encodeURIComponent(license.id)}/login`, {
      onComplete: () => {
        say(harness, `${license.label} is signed in.`);
        if (panel?.id === license.id) closePanel();
        void afterMutation();
      },
    });
  }

  // A Claude sign-in license is signed in on the gateway host, with the command the listing gives.
  function openHostSignIn(license, harness) {
    const el = make("div", "lic-panel");
    const command = make("code", "", license.loginCommand || "");
    const pre = make("pre");
    pre.append(command);
    const copyState = make("span", "state");
    copyState.setAttribute("role", "status");
    copyState.setAttribute("aria-live", "polite");
    const actions = make("div", "row-actions");
    actions.append(
      button("Copy command", "ghost lic-copy-command", async () => {
        copyState.textContent = "Copying…";
        copyState.textContent = (await copyText(license.loginCommand || "")) ? "Copied" : "Could not copy — select the command and copy it manually.";
      }),
      button("Check again", "ghost lic-check-again", () => verify(license, harness)),
      button("Close", "ghost lic-signin-close", () => { closePanel(); paint(); }),
      copyState,
    );
    el.append(
      make("strong", "", `Sign in ${license.label}`),
      make("p", "desc", "Run this in a terminal on the gateway host, sign in when the CLI asks, then check again."),
      pre,
      actions,
    );
    panel = { id: license.id, el };
    paint();
  }

  function openForm(harness, license = null) {
    if (refuseIfBlocked(harness)) return;
    const kinds = list(catalog?.kinds).filter((kind) => kind.harness === harness);
    if (!license && !kinds.length) { say(harness, "This harness has no license kind to add.", true); paint(); return; }
    const el = make("div", "lic-form");
    const typeLabel = (id) => list(catalog?.types).find((type) => type.id === id)?.label || id;
    const manifest = license ? list(state().manifests).find((m) => m.id === license.id) : null;

    const kindSelect = make("select", "lic-kind");
    kindSelect.replaceChildren(...(license ? [option(license.kind, license.kindLabel || license.kind)] : kinds.map((kind) => option(kind.id, kind.label))));
    kindSelect.disabled = Boolean(license);
    const kindHelp = make("em", "state lic-kind-help");
    const kindField = field("Kind", kindSelect);
    kindField.append(kindHelp);

    const nameInput = make("input", "lic-label");
    nameInput.type = "text";
    nameInput.maxLength = 60;
    nameInput.autocomplete = "off";
    nameInput.placeholder = "e.g. Work plan";
    nameInput.value = license?.label || "";

    const typeSelect = make("select", "lic-type-select");

    const urlInput = make("input", "lic-base-url");
    urlInput.type = "url";
    urlInput.autocomplete = "off";
    urlInput.value = license?.baseUrl || "";
    // Write-only. The stored key is never sent to the page; an edit shows its last four characters
    // as a placeholder and a blank box keeps it.
    const keyInput = make("input", "lic-api-key");
    keyInput.type = "password";
    keyInput.autocomplete = "new-password";
    keyInput.placeholder = license?.hasApiKey ? `•••• ${license.apiKeyLast4 || ""}`.trim() : "API key";
    const schemeSelect = make("select", "lic-auth-scheme");
    const regionInput = make("input", "lic-region");
    regionInput.type = "text";
    regionInput.autocomplete = "off";
    regionInput.maxLength = 40;
    regionInput.value = license?.region || "";
    const projectInput = make("input", "lic-project-id");
    projectInput.type = "text";
    projectInput.autocomplete = "off";
    projectInput.maxLength = 30;
    projectInput.placeholder = "my-project-123456";
    projectInput.value = license?.projectId || "";
    // Write-only like the key: the stored file is never sent back, only whose key it is.
    const accountInput = make("textarea", "lic-service-account");
    accountInput.rows = 4;
    accountInput.autocomplete = "off";
    accountInput.spellcheck = false;
    accountInput.placeholder = license?.hasServiceAccount
      ? `Stored: ${license.serviceAccountEmail || "a service-account key"}. Paste a new key file to replace it.`
      : 'Paste the key file: { "type": "service_account", … }';
    const versionInput = make("input", "lic-api-version");
    versionInput.type = "text";
    versionInput.autocomplete = "off";
    versionInput.maxLength = 40;
    versionInput.placeholder = "e.g. 2025-04-01-preview";
    versionInput.value = license?.apiVersion || "";
    const modelsInput = make("textarea", "lic-models");
    modelsInput.rows = 3;
    modelsInput.placeholder = "One model id per line, or comma-separated";
    modelsInput.value = list(license?.models).map((model) => model.value).join("\n");
    const keep = license ? " Leave blank to keep the stored one." : " Sent once and never shown again.";
    // One labelled row per field a kind can ask for; paintKind shows the ones this kind does.
    const providerControls = {
      baseUrl: urlInput, region: regionInput, projectId: projectInput, apiKey: keyInput,
      serviceAccount: accountInput, authScheme: schemeSelect, apiVersion: versionInput, models: modelsInput,
    };
    const providerRows = Object.fromEntries(Object.entries(providerControls).map(([name, control]) => {
      const row = field(name, control, " ");
      row.classList.add("lic-provider-field");
      row.dataset.field = name;
      return [name, row];
    }));
    const apiFields = make("div", "lic-api-fields");

    // Per-license defaults are ordinary settings keys the manifest names (defaultModelKey / defaultEffortKey).
    const modelSelect = make("select", "lic-default-model");
    const effortSelect = make("select", "lic-default-effort");
    const defaults = make("div", "lic-default-fields");
    if (manifest?.defaultModelKey && manifest?.defaultEffortKey) {
      modelSelect.replaceChildren(option("", "CLI default"), ...list(manifest.models).map((model) => option(model.value, model.label || model.value)));
      if (license.defaultModel && !list(manifest.models).some((model) => model.value === license.defaultModel)) modelSelect.append(option(license.defaultModel, license.defaultModel));
      modelSelect.value = license.defaultModel || "";
      effortSelect.replaceChildren(option("", "CLI default"), ...list(manifest.efforts).map((effort) => option(effort, effort)));
      if (license.defaultEffort && !list(manifest.efforts).includes(license.defaultEffort)) effortSelect.append(option(license.defaultEffort, license.defaultEffort));
      effortSelect.value = license.defaultEffort || "";
      defaults.append(field("Default model", modelSelect), field("Default effort", effortSelect, "Used when no thread or conversation effort is set."));
    }

    const paintKind = () => {
      const kind = kinds.find((entry) => entry.id === kindSelect.value) || list(catalog?.kinds).find((entry) => entry.id === kindSelect.value);
      kindHelp.textContent = kind?.description || "";
      const types = list(kind?.types);
      const keepType = typeSelect.value || license?.type || "";
      typeSelect.replaceChildren(...types.map((id) => option(id, typeLabel(id))));
      // A stored type its kind no longer lists stays selectable on an edit; switching the kind of
      // a new license never carries a type the new kind does not have.
      if (license?.type && !types.includes(license.type)) typeSelect.append(option(license.type, typeLabel(license.type)));
      typeSelect.value = [...typeSelect.options].some((entry) => entry.value === keepType) ? keepType : types[0] || "";
      const traits = kindTraits(kind || kindSelect.value, catalog);
      apiFields.hidden = !traits.provider;
      // Rows in the order the kind lists its fields, worded for its provider.
      apiFields.replaceChildren(...traits.fields.map((name) => providerRows[name]).filter(Boolean));
      for (const name of traits.fields) {
        const row = providerRows[name];
        if (!row) continue;
        const [label, help = ""] = fieldCopy(name, kind?.provider);
        const secret = name === "apiKey" || name === "serviceAccount";
        row.querySelector("span").textContent = label;
        row.querySelector("em").textContent = `${name === "models" ? kind?.hints?.models || help : help}${secret ? `${help ? " " : ""}Write-only.${keep}` : ""}`.trim();
      }
      urlInput.placeholder = kind?.hints?.baseUrl || kind?.defaultBaseUrl || "https://";
      regionInput.placeholder = kind?.hints?.region || "";
      const schemes = list(kind?.authSchemes);
      const scheme = schemeSelect.value || license?.authScheme || "";
      schemeSelect.replaceChildren(...schemes.map((id) => option(id, AUTH_SCHEME_LABELS[id] || id)));
      schemeSelect.value = schemes.includes(scheme) ? scheme : schemes[0] || "";
      // A kind with one way to send its key has nothing to choose.
      if (providerRows.authScheme) providerRows.authScheme.hidden = schemes.length < 2;
    };
    kindSelect.addEventListener("change", paintKind);
    paintKind();

    const formState = make("span", "state lic-form-state");
    formState.setAttribute("role", "status");
    const save = button(license ? "Save license" : "Add license", "lic-save", async () => {
      const kind = kindSelect.value;
      const body = { label: nameInput.value, type: typeSelect.value };
      if (!license) body.kind = kind;
      // A credential leaves its box before the request does; it is in this one body and nowhere else.
      const typedKey = keyInput.value;
      const typedAccount = accountInput.value;
      keyInput.value = "";
      accountInput.value = "";
      const asks = new Set(kindTraits(kind, catalog).fields);
      if (asks.has("baseUrl")) body.baseUrl = urlInput.value.trim();
      if (asks.has("region")) body.region = regionInput.value.trim();
      if (asks.has("projectId")) body.projectId = projectInput.value.trim();
      if (asks.has("apiVersion")) body.apiVersion = versionInput.value.trim();
      if (asks.has("authScheme")) body.authScheme = schemeSelect.value;
      if (asks.has("models")) body.models = parseModelList(modelsInput.value);
      if (asks.has("apiKey") && typedKey.trim()) body.apiKey = typedKey.trim();
      if (asks.has("serviceAccount") && typedAccount.trim()) body.serviceAccount = typedAccount.trim();
      save.disabled = true;
      formState.textContent = "Saving…";
      try {
        const result = await api(license ? `/api/engine-licenses/${encodeURIComponent(license.id)}` : "/api/engine-licenses", { method: license ? "PUT" : "POST", body: JSON.stringify(body) });
        const saved = result.license || {};
        if (license && manifest?.defaultModelKey && (modelSelect.value !== (license.defaultModel || "") || effortSelect.value !== (license.defaultEffort || ""))) {
          await api("/api/settings", { method: "PUT", body: JSON.stringify({ [manifest.defaultModelKey]: modelSelect.value, [manifest.defaultEffortKey]: effortSelect.value }) });
        }
        const badge = licenseStatusBadge({ ...saved, verification: result.verification ?? saved.verification });
        say(harness, `${license ? "Saved" : "Added"} ${saved.label || body.label}${badge.tone === "ok" ? "." : ` — ${badge.text.toLowerCase()}${badge.detail ? `: ${badge.detail}` : "."}`}`, badge.tone === "bad");
        closeForm();
        await afterMutation();
      } catch (error) {
        save.disabled = false;
        formState.textContent = `✗ ${error.message}${body.apiKey ? " Enter the API key again." : ""}${body.serviceAccount ? " Paste the key file again." : ""}`;
      }
    });
    const actions = make("div", "row-actions");
    actions.append(save, button("Cancel", "ghost lic-cancel", () => { closeForm(); paint(); }), formState);
    el.append(
      make("strong", "", license ? `Edit ${license.label}` : `Add a ${harnessLabelOf(state().manifests, harness) || list(catalog?.harnesses).find((h) => h.id === harness)?.label || harness} license`),
      kindField,
      field("Name", nameInput, "How this license is listed in every picker."),
      field("Type", typeSelect),
      apiFields,
      defaults,
      actions,
    );
    form = { harness, id: license?.id || "", el };
    paint();
    nameInput.focus();
  }

  function licenseRow(manifest, record, { onCount }) {
    const { enabled } = state();
    const id = manifest.id;
    const harness = harnessOf(manifest);
    const on = enabled?.[id] !== false;
    const row = make("div", "lic-row");
    row.dataset.license = id;

    const toggle = make("label", "engine-toggle");
    const input = make("input");
    input.type = "checkbox";
    input.checked = on;
    // The last license left on cannot be switched off — the daemon would have nothing to run, and
    // the API refuses that state anyway.
    input.disabled = on && !manifest.channelScoped && onCount === 1;
    input.title = input.disabled ? "At least one license must stay switched on" : "";
    input.addEventListener("change", () => setEnabled(id, input.checked));
    toggle.append(input, " ", make("span", "lic-name", record?.label || licenseLabelOf(manifest)));
    const note = record ? "" : builtinNote(manifest);
    if (note) toggle.append(make("em", "state", note));
    // A provider license says where it runs as well as how it is billed: "Amazon Bedrock · API".
    const kindLabel = record && kindTraits(record.kind, catalog).provider ? record.kindLabel || "" : "";
    const typeText = record ? [kindLabel, record.typeLabel || record.type || ""].filter(Boolean).join(" · ") : "Built-in";
    row.append(toggle, make("span", "lic-type", typeText));

    let badge = null;
    if (record) badge = licenseStatusBadge(record);
    else {
      const check = health(id);
      if (check) {
        const signedOut = check.auth?.known === true && check.auth.authenticated === false;
        badge = !check.available ? { tone: "warn", text: "Unavailable", detail: String(check.reason || "") }
          : signedOut ? { tone: "warn", text: "Not signed in", detail: String(check.auth.detail || "") }
          : { tone: "ok", text: "Ready", detail: "" };
      }
    }
    const status = make("span", `lic-status ${badge?.tone || ""}`.trim(), badge?.text || "");
    row.append(status);

    const actions = make("span", "lic-actions");
    if (record) {
      const traits = kindTraits(record.kind, catalog);
      if (traits.browserSignIn) actions.append(button("Sign in", "clear-tok lic-signin", () => openSignIn(record, harness)));
      else if (record.loginCommand) actions.append(button("Sign in", "clear-tok lic-signin", () => openHostSignIn(record, harness)));
      actions.append(
        button("Edit", "clear-tok lic-edit", () => openForm(harness, record)),
        button("Verify", "clear-tok lic-verify", () => verify(record, harness)),
        button("Remove", "clear-tok lic-remove", () => remove(record, harness)),
      );
    } else {
      const jump = openBuiltin(manifest);
      if (jump) actions.append(button("Settings", "clear-tok lic-settings", jump));
      // The harness's own sign-in can be named and never removed; every other license the gateway
      // ships with can be removed (and restored from the line under the list).
      if (manifest.defaultLicense) actions.append(button("Rename", "clear-tok lic-rename-open", () => openRename(manifest, harness)));
      else if (manifest.removable) actions.append(button("Remove", "clear-tok lic-remove", () => removeBuiltin(manifest, harness)));
    }
    row.append(actions);
    if (on && badge?.detail && badge.tone !== "ok") row.append(make("div", "lic-detail state", badge.detail));
    if (panel?.id === id) row.append(panel.el);
    if (form?.id && form.id === id) row.append(form.el);
    return row;
  }

  function paint() {
    const { manifests, enabled } = state();
    if (!list(manifests).length) return;
    const onCount = manifests.filter((m) => !m.channelScoped && enabled?.[m.id] !== false).length;
    const atMax = catalog?.max != null && licenses.length >= catalog.max;
    const groups = harnessList(manifests).map((h) => {
      const group = make("div", "lic-group");
      group.dataset.harness = h.id;
      const head = make("div", "lic-group-head");
      const add = button("Add license", "ghost lic-add", () => openForm(h.id));
      add.disabled = !catalog || atMax || !list(catalog?.kinds).some((kind) => kind.harness === h.id);
      add.title = atMax ? `No more than ${catalog.max} licenses can be stored.` : "";
      head.append(make("strong", "lic-group-title", `${h.label} licenses`), add);
      const rows = make("div", "lic-rows");
      rows.append(...manifests.filter((m) => harnessOf(m) === h.id).map((m) => licenseRow(m, recordOf(m.id), { onCount })));
      group.append(head, rows);
      const gone = removed.filter((entry) => entry.harness === h.id);
      if (gone.length) {
        const line = make("div", "lic-removed state");
        line.append(make("span", "lic-removed-title", "Removed:"));
        for (const entry of gone) {
          const item = make("span", "lic-removed-item");
          item.dataset.license = entry.id;
          item.append(make("span", "", entry.label), button("Restore", "clear-tok lic-restore", () => restore(entry, h.id)));
          line.append(item);
        }
        group.append(line);
      }
      const notice = notices.get(h.id);
      if (notice) {
        const line = make("div", `state lic-notice${notice.bad ? " bad" : ""}`, notice.text);
        line.setAttribute("role", "status");
        group.append(line);
      }
      if (form && !form.id && form.harness === h.id) group.append(form.el);
      return group;
    });
    // A panel whose license is gone has nowhere to sit.
    if (panel && !manifests.some((m) => m.id === panel.id)) closePanel();
    if (form?.id && !manifests.some((m) => m.id === form.id)) closeForm();
    root.replaceChildren(...groups, ...(loadError ? [make("div", "state lic-notice bad", loadError)] : []));
  }

  return { paint, load };
}
