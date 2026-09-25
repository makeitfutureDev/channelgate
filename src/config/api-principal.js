// The HTTP run API's principal. `POST /api/runs` authenticates the run API key (or an admin
// session), and that key is an ADMIN credential. Inside a run it acts as ONE fixed principal: an
// admin of the target channel with every channel capability a message gets (Auto/Admin mode, memory,
// skills, connectors, the gateway tools), but with no person behind it — so no personal scope: no
// personal Composio/Toolbox token, secrets, skills or SSH keys, and the channel's/agent's Composio
// identity only. The `author` a request names is attribution only. Work that outlives the run
// (background jobs/agents, schedules) is owned by this same principal. Per-user API keys that act
// as a proven person are a planned follow-up.
//
// Dependency-free on purpose: the config store and the gateway both need it without an import
// cycle. Not a Slack id shape, and no platform namespaces a bare word, so no real author matches it.
export const API_PRINCIPAL = "api";
export function isApiPrincipal(id) {
  return String(id || "") === API_PRINCIPAL;
}
