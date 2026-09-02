// Curated catalog of deploy/infra CLIs a Bash+network channel may use IN-SANDBOX. Enabling an
// integration (Settings → Network) does two narrow things, mirroring the long-standing git/gh
// carve-out: its domains join the network egress allow-list, and the CLI's saved-login files
// become READABLE (never writable) to write-capable network channels — so e.g. `vercel deploy`
// can run inside the folder sandbox instead of falling back to the unsandboxed background shell
// and its per-command admin approval.
//
// This module is PURE data + functions (no imports, no settings access) so config, gateway, and
// web layers can all use it without import cycles. To add a CLI: append an entry here — domains
// must pass util/network-domains.js normalization; credentialHomePaths are HOME-relative, may
// cover macOS and Linux variants (absent ones are skipped at link time), and are granted
// read-only, so a token can only ever travel to the allow-listed domains.
//
// `envKeys` are the environment variables that CLI accepts INSTEAD of its saved login. They are
// what a channel sets to act as its own account rather than the daemon's single host-wide one
// (config/channel-env.js): the secrets UI suggests them for the channel's enabled integrations,
// and hostCredentialSuppressedBy() reads them so a channel supplying its own key stops getting the
// shared credential linked in behind it — a silent fallback to a different identity is worse than
// a loud failure. Order matters only for display.

export const CLI_INTEGRATIONS = {
  vercel: {
    label: "Vercel",
    bins: ["vercel"],
    desc: "vercel CLI deploys (`vercel`, `vercel deploy`)",
    domains: ["vercel.com", "api.vercel.com", "*.vercel.app"],
    envKeys: ["VERCEL_TOKEN"],
    credentialHomePaths: [
      // Current CLI: per-platform data dir. Legacy CLI: ~/.vercel/auth.json.
      "Library/Application Support/com.vercel.cli",
      ".local/share/com.vercel.cli",
      ".config/com.vercel.cli",
      ".vercel",
    ],
  },
  supabase: {
    label: "Supabase",
    bins: ["supabase"],
    desc: "supabase CLI management operations (link, functions deploy, db push over HTTPS)",
    domains: ["supabase.com", "api.supabase.com", "*.supabase.co"],
    envKeys: ["SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_PASSWORD"],
    // Keychain-less fallback token store; on macOS the CLI may use the system keychain instead,
    // in which case only the file fallback works inside the sandbox.
    credentialHomePaths: [".supabase"],
  },
  make: {
    label: "Make.com",
    bins: [], // API-only — no local CLI to detect
    desc: "Make.com API calls (scenarios, blueprints) — token comes from env/config, not a home file",
    domains: ["make.com", "*.make.com"],
    envKeys: ["MAKE_API_TOKEN"],
    credentialHomePaths: [],
  },
};

export function cliIntegrationIds() {
  return Object.keys(CLI_INTEGRATIONS);
}

// Filter an arbitrary stored/user value down to known catalog ids (order + dedupe preserved).
export function normalizeCliIntegrations(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const raw of value) {
    const id = String(raw ?? "").trim().toLowerCase();
    if (id && Object.hasOwn(CLI_INTEGRATIONS, id)) seen.add(id);
  }
  return [...seen];
}

export function cliNetworkDomains(ids) {
  const out = new Set();
  for (const id of normalizeCliIntegrations(ids)) {
    for (const domain of CLI_INTEGRATIONS[id].domains) out.add(domain);
  }
  return [...out];
}

// Every env name any catalog CLI understands, for the "suggested names" affordance in the UI.
export function cliEnvKeys(ids) {
  const out = new Set();
  for (const id of normalizeCliIntegrations(ids)) {
    for (const key of CLI_INTEGRATIONS[id].envKeys || []) out.add(key);
  }
  return [...out];
}

// Which integrations this channel has taken over with its own credential. A channel that sets
// SUPABASE_ACCESS_TOKEN is acting as ITS account, so linking the daemon's shared ~/.supabase in
// behind it only creates a second identity that silently answers when the first is missing.
export function hostCredentialSuppressedBy(envNames = []) {
  const names = new Set([...envNames].map((n) => String(n || "")));
  return cliIntegrationIds().filter((id) => (CLI_INTEGRATIONS[id].envKeys || []).some((key) => names.has(key)));
}

export function cliCredentialHomePaths(ids) {
  const out = new Set();
  for (const id of normalizeCliIntegrations(ids)) {
    for (const p of CLI_INTEGRATIONS[id].credentialHomePaths) out.add(p);
  }
  return [...out];
}

// EVERY catalog credential path, enabled or not — the writable-folder sandbox uses an enumerated
// write-deny list, so a CLI's saved login must be on it unconditionally: a disabled integration's
// token is no more tamperable than an enabled one's, and enabling must never LOOSEN writes.
export function allCliCredentialHomePaths() {
  return cliCredentialHomePaths(cliIntegrationIds());
}

// The always-on baseline behind `git push`/`gh` for write + approved-network runs. known_hosts
// ONLY — never keys or ssh config; auth stays agent-based (SSH_AUTH_SOCK). One list feeds the
// Claude sandbox read re-allows, both synthetic-HOME link sets, and the Codex read grants.
export const GIT_TOOLING_HOME_PATHS = [".gitconfig", ".git-credentials", ".config/git", ".config/gh", ".ssh/known_hosts"];

// Shape the admin UI renders its checkboxes from (id + display metadata, nothing resolved).
export function publicCliCatalog() {
  return Object.entries(CLI_INTEGRATIONS).map(([id, entry]) => ({
    id,
    label: entry.label,
    desc: entry.desc,
    domains: [...entry.domains],
    envKeys: [...(entry.envKeys || [])],
    credentialHomePaths: [...entry.credentialHomePaths],
    bins: [...(entry.bins || [])],
  }));
}
