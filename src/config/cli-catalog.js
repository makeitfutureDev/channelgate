// Curated catalog of the deploy/infra CLIs the channel runtime ships (see containers/versions.json
// for the pinned versions). Two things read it:
//   - `envKeys`: the environment variables each CLI accepts instead of a saved login. They are what
//     a channel sets through `/secrets` to act as ITS OWN account (config/channel-env.js) — the
//     secrets UI suggests every catalog name, so nobody guesses "SUPABASE_TOKEN" for a CLI that
//     reads SUPABASE_ACCESS_TOKEN.
//   - `credentialHomePaths`: where each CLI keeps a saved login on a HOST. The host-sandbox runtime
//     write-denies them in writable folders (a token on disk is never tamperable from a run); it
//     never links them into a run any more.
// The "Settings → Network → CLI integrations" switch that used to add `domains` to the host
// egress allow-list and link the daemon's shared `~/.supabase` into runs was retired on
// 2026-09-03: the product runs Linux + containers only, a container has no domain allow-list, and
// its image ships the CLIs. `domains` stay as documentation of what each CLI talks to.
//
// This module is PURE data + functions (no imports, no settings access) so config, gateway, and
// web layers can all use it without import cycles.

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
    // The CLI's keychain-less token store — the one a headless Linux host uses.
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

// Every env name any catalog CLI understands, for the "suggested names" affordance in the UI.
export function cliEnvKeys(ids) {
  const out = new Set();
  for (const id of normalizeCliIntegrations(ids)) {
    for (const key of CLI_INTEGRATIONS[id].envKeys || []) out.add(key);
  }
  return [...out];
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
