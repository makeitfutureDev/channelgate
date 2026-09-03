// Pure client-state reconciliation helpers. Kept DOM-free so save behavior can be regression
// tested without a browser harness.

export function reconcileChannelMeta(current = {}, saved = {}) {
  const next = { ...current, ...saved };
  for (const prefix of ["composio", "skills", "toolbox"]) {
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
    label: `${member.name || member.id} (${member.id})${member.isExternal ? " · external" : ""}`,
  }));
}

export function channelGuestSavePatch(ready, selectedIds) {
  if (!ready) return {};
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
  return [
    ...availableNames.map((name) => ({ value: name, label: name })),
    ...savedNames.filter((name) => !known.has(name)).map((name) => ({ value: name, label: `${name} · unavailable` })),
  ];
}
