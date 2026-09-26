import { safeSpawnEnv } from "../config/channel-env.js";

// Group the injected names by the SCOPE that supplied each one (config/scoped-env.js). A bare
// list was enough while a channel's own secrets were the only kind; with three scopes the agent
// has to be able to say WHICH account it acted as, and "the name was there" no longer answers
// that. Names only — a scope is not a value.
function scopeLines(names, scopes) {
  const by = { organization: [], personal: [], channel: [] };
  for (const name of names) by[scopes[name] || "channel"].push(name);
  // Only worth saying when there is something to tell apart. With one scope in play the list
  // above already names every variable, and a second line repeating it is prompt noise.
  if (Object.values(by).filter((group) => group.length).length < 2) return [];
  const lines = [];
  if (by.organization.length) {
    lines.push(`Organization-wide variables (shared by every conversation in this deployment): ${JSON.stringify(by.organization)}.`);
  }
  if (by.personal.length) {
    lines.push(`Personal variables belonging to the author of THIS message, injected only into runs they authored: ${JSON.stringify(by.personal)}.`);
  }
  if (by.channel.length) {
    lines.push(`This conversation's own variables: ${JSON.stringify(by.channel)}.`);
  }
  return lines;
}

// The egress proxy's half (src/gateway/egress/grants.js resolveEgressRunEnv): which names hold a
// PLACEHOLDER that only works through the proxy and on which hosts, which hold the raw value, and
// which were withheld under egressSecretsStrict. Only said when the proxy is this run's egress —
// otherwise every value is real and there is nothing to tell apart.
function egressLines(names, { scopes = {}, placeholders = {}, hosts = {}, unprotected = [], withheld = [], personalPaused = false } = {}) {
  const lines = [];
  for (const name of names) {
    if (!placeholders[name]) continue;
    const on = (hosts[name] || []).join(", ") || "its declared hosts";
    lines.push(`${name} is proxy-protected: its value in the environment is a placeholder that only works from this container through the gateway's egress proxy on: ${on}. Use it exactly as you would the real credential (the CLI or HTTP client sends it; the proxy swaps it in flight); it is worthless anywhere else.`);
  }
  // A personal placeholder swaps only while its owner is the one working here and no OTHER person
  // has a turn, a background job or an SSH session active in this channel
  // (src/gateway/egress/liveness.js). Say so up front: the agent otherwise reads the 403 as a bad
  // credential and goes hunting for another one.
  const personal = names.filter((name) => placeholders[name] && scopes[name] === "personal");
  if (personal.length) {
    lines.push(`Personal placeholders ${JSON.stringify(personal)} work only while their owner is the one working in this conversation: they PAUSE (the proxy answers 403 another-author-active or another-person-ssh-session) while another person's turn, background job or SSH session is active here. Say so and retry later rather than asking for the raw value.`);
  }
  if (personalPaused && personal.length) lines.push(`Personal secrets are PAUSED right now: another person's turn, background job or SSH session is active in this conversation's container, so the egress proxy refuses to use ${JSON.stringify(personal)} (403 "another-author-active" or "another-person-ssh-session") until it ends. Do not retry or substitute another credential; tell the author, or use a conversation/organization credential they approve.`);
  const raw = unprotected.filter((name) => names.includes(name));
  if (raw.length) lines.push(`Unprotected (the RAW value is in the environment — no egress rule declares where it may be used): ${JSON.stringify(raw)}.`);
  if (withheld.length) lines.push(`Withheld by the gateway's strict egress setting (no egress rule, so not injected at all): ${JSON.stringify([...withheld].sort())}. Ask an admin to declare "used on hosts" for them if this task needs them.`);
  return lines;
}

// Describe the SAME resolved environment the runners receive, never the stored metadata or the
// daemon's process.env. Rebuild per turn so a resumed conversation cannot retain a revoked name.
export function channelCredentialsPreamble(resolved = {}, { clean = false, scopes = {}, placeholders = {}, hosts = {}, unprotected = [], withheld = [], personalPaused = false } = {}) {
  if (clean) return "";
  const names = Object.keys(safeSpawnEnv(resolved)).sort();
  return "[Channel credentials for THIS attempt]\n"
    + `Available channel environment variable names: ${JSON.stringify(names)}.\n`
    + scopeLines(names, scopes).map((line) => `${line}\n`).join("")
    + egressLines(names, { scopes, placeholders, hosts, unprotected, withheld, personalPaused }).map((line) => `${line}\n`).join("")
    + "This inventory replaces earlier turns' channel credential inventories. It lists only variables injected into this run; an empty list means none were injected, not that all CLI logins or MCP connections are absent.\n"
    + "Before declaring missing access or requesting a new connection, check relevant names here alongside task skills, existing CLI authentication and MCP tools. These variables are usable from the process environment for authorized API/CLI calls; they are not a project .env file. Some clients require explicitly passing the variable.\n"
    + "A variable name does not prove its account, permissions or validity. Where a conversation variable and a personal one could both serve a request, the conversation's is the one already in force — the personal scope only fills names the conversation does not define. Preserve the requested account; ask when identity is ambiguous and never silently substitute one scope's credential for another's.\n"
    + "Respect this run's tool and network permissions.\n"
    + "Check presence without printing values. Never dump the environment, print credentials, or copy them into files, replies or memory.\n"
    + "[End channel credentials]\n\n";
}
