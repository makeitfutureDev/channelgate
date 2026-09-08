// Pure client-state reconciliation helpers. Kept DOM-free so save behavior can be regression
// tested without a browser harness.

export function reconcileChannelMeta(current = {}, saved = {}) {
  const next = { ...current, ...saved };
  for (const prefix of ["composio", "toolbox"]) {
    const tokenKey = `${prefix}Token`;
    if (!Object.prototype.hasOwnProperty.call(saved, tokenKey)) continue;
    const token = String(saved[tokenKey] || "");
    const cap = prefix[0].toUpperCase() + prefix.slice(1);
    next[`has${cap}Token`] = Boolean(token);
    next[`${prefix}TokenLast4`] = token ? token.slice(-4) : "";
  }
  if (Object.prototype.hasOwnProperty.call(saved, "makeToolboxKey")) {
    const key = String(saved.makeToolboxKey || "");
    next.hasMakeToolboxKey = Boolean(key);
    next.makeToolboxKeyLast4 = key ? key.slice(-4) : "";
  }
  return next;
}

export async function loadChannelGuestOptions(request, channelId) {
  const result = await request(`/api/channels/${encodeURIComponent(channelId)}/members`);
  if (!Array.isArray(result?.members)) throw new Error("Slack did not return a valid member roster.");
  return result.members.map((member) => ({
    value: String(member.id),
    label: `${member.name || member.id} (${member.id})${member.admin ? " · admin" : member.approved ? " · approved" : ""}${member.isExternal ? " · external" : ""}`,
    inherited: Boolean(member.approved),
    locked: Boolean(member.admin),
  }));
}

export function channelGuestSavePatch(ready, selectedIds, changed = false) {
  // A successful roster may omit a saved grant. Only an explicit guest edit authorizes
  // replacing the list; an unrelated save must not turn a partial display into revocation.
  if (!ready || !changed) return {};
  return {
    allowedUsers: [...new Set((selectedIds || []).map(String))],
  };
}

export function channelGuestAcceptedIds(ready, allowedUsers) {
  if (!ready) return null;
  return [...new Set((allowedUsers || []).map(String))];
}

// MCP discovery is asynchronous. While an engine's catalog is loading the checklist DOM is
// intentionally replaced by a loading message, so reading checked inputs at that moment would
// produce [] and erase a saved selection on an unrelated Save. Keep the authoritative state until
// real checkboxes are ready; once ready, adopt the visible selection (including an intentional []).
export function captureGrantMcpSelection(current = {}, engine = "", visible = [], loading = false) {
  const state = {
    claude: Array.isArray(current.claude) ? [...new Set(current.claude.map(String))] : [],
    codex: Array.isArray(current.codex) ? [...new Set(current.codex.map(String))] : [],
  };
  if (loading || !["claude", "codex"].includes(engine)) return state;
  state[engine] = [...new Set((visible || []).map(String))];
  return state;
}

// A granted skill may be temporarily absent from discovery (a source is offline, a plugin is
// being upgraded, or a saved config came from another host). Keep it selectable and checked so
// saving an unrelated setting does not silently revoke it. Available names retain their normal
// order; saved-only names append once with an explicit offline label.
export function accessGrantSkillOptions(available = [], saved = []) {
  const availableNames = [...new Set((available || []).filter((name) => typeof name === "string").map((name) => name.trim()).filter(Boolean))];
  const savedNames = [...new Set((saved || []).filter((name) => typeof name === "string").map((name) => name.trim()).filter(Boolean))];
  const known = new Set(availableNames);
  const enabled = new Set(savedNames);
  return [
    ...availableNames
      .map((name) => ({ value: name, label: name, enabled: enabled.has(name) }))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.label.localeCompare(b.label)),
    ...savedNames.filter((name) => !known.has(name)).map((name) => ({ value: name, label: `${name} · unavailable` })),
  ];
}

// ── Global settings: send the CHANGE, not the page ────────────────────────────────────────────
// The Settings page is one long form with a single Save. Re-submitting all of it re-asserted every
// field as the page happened to have loaded them, so anything written after that load — by another
// admin, by the skills sync, by a license or password write — was silently reverted by an
// unrelated save minutes later. So Save now sends only what actually differs from the snapshot the
// page was painted from, and the server merges it (settings.js saveSettings has always been a
// merge). A key the admin never touched is simply absent, and therefore cannot revert anything.
//
// A key MISSING from the baseline counts as changed: that is how the write-only fields work (a
// token, a clear flag, a new password appear only once they are set), and re-sending one is
// exactly what the admin asked for.
export function settingValuesEqual(a, b) {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  // Objects and arrays are built by the same reader on both sides, so their key order matches and
  // a serialized compare is a structural compare.
  if (typeof a === "object" || typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false; // a cycle can only come from a bug — treat it as changed and let the server decide
    }
  }
  return false;
}

export function diffSettingsPayload(baseline = {}, next = {}) {
  const patch = {};
  for (const [key, value] of Object.entries(next || {})) {
    if (value === undefined) continue; // JSON.stringify would drop it anyway
    if (Object.prototype.hasOwnProperty.call(baseline || {}, key) && settingValuesEqual(baseline[key], value)) continue;
    patch[key] = value;
  }
  return patch;
}

// What a stale save collided with: the keys whose value moved between the server representation
// the page was painted from and the one the server just returned. Both sides are the SAME shape
// (an /api/settings payload), never the form-shaped snapshot the diff above uses. `ignore` drops
// the live, non-setting parts of that payload — a connection snapshot changes on its own and is
// not something anybody overwrote.
export function changedSettingKeys(before = {}, after = {}, ignore = []) {
  const skip = new Set(ignore);
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((key) => !skip.has(key) && !settingValuesEqual(before?.[key], after?.[key])).sort();
}
