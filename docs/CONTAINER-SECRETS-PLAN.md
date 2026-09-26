# Container secrets, MCP tokens, SSH sessions and egress — implementation plan

Status: design accepted in principle on 2026-09-26 (thread in #channelgate-development); not yet
implemented. Branch `docs/container-secrets-network`. This document is the plan of record for the
work; `FEATURES.md` and `TEST-PLAN.md` are updated phase by phase as code lands.

## 1. Decisions

1. **No per-developer Unix user, ever.** A channel container keeps one `agent` account at the
   daemon's uid, one HOME volume per channel, nothing per person. Per-person accounts would add
   provisioning, volume space and sshd/uid bookkeeping for a guarantee we do not need (below).
2. **The channel container is a shared trust domain.** Everyone the channel admits (a chat author,
   a developer attached over SSH, a background job, the memory reviewer) runs as the same uid and
   can read every other process's environment and files in that container. That is already true
   today with REAL secret values. The goal of this work is not to hide members from each other but
   to make anything a member can take **worthless outside its run**.
3. **The container never holds a real credential.** It holds *placeholders*. A host-side egress
   proxy swaps a placeholder for the real value only on requests to the hosts and headers that
   secret is declared for. Every other credential path (remote MCP headers, the Claude relay
   token, SSH session files) moves behind a daemon-side broker or becomes a placeholder too.
4. **`--network none` for every ordinary container.** Egress exists only through a per-channel
   Unix socket relayed to the daemon's proxy, the same pattern as the control MCP socket. There is
   no bridge interface to bypass, no iptables, nothing to audit for gaps: a tool that ignores
   `HTTPS_PROXY` has no network at all. The per-channel *Allow network* switch becomes live proxy
   policy and `NETWORK_POLICY_ENFORCED` flips to `true`.
5. **Personal secrets are owner-bound handles.** A personal placeholder is minted per
   (channel, author) and is swapped only while that author has a live turn or SSH session in the
   channel, and never while a *different* person has an SSH session open there. That closes the one
   practical cross-member leak (a developer sitting in the container reading another author's
   environment) without OS accounts. The residual — two admitted members reusing each other's
   *shared-channel* handles while both are inside — is bounded, provider-scoped, time-limited and
   audit-attributed, and both members were already trusted with those shared secrets.
6. **In-house proxy in Node, with an explicit spike gate.** iron-proxy binds a TCP bridge gateway
   and keys its rules on a static config; our ingress is a per-channel Unix socket and our rules
   live in SQLite with owner/liveness checks, so adopting it means forking it anyway. A Node
   implementation (`node:tls` + `node:http`, no new runtime dependency, no Go toolchain in the
   image) is the plan; if the spike in §4 fails its streaming, WebSocket or auth-refresh tests, a
   pinned iron-proxy fork behind the same Unix-socket transport is the fallback.
7. **`/sudo` host threads and the operator-home mount are outside every promise here.** They are
   explicit admin-only escapes and stay as documented in `AGENTS.md`.

## 2. Where credentials reach a container today (verified 2026-09-26)

| Path | File / mechanism | Container-visible? | Fix in |
|---|---|---|---|
| Org / channel / personal env secrets | `--env-file` under `~/.channelgate/channels/<p>/<slug>/runtime/env/<run>.env` (0600, unmounted) but values land in the process environment (`src/runtimes/container/exec.js:109`) | yes (env of every process, `/proc/*/environ`) | P2 |
| Remote MCP headers (Composio user/agent legacy, toolbox, Make, catalog servers) | `cg-mcp-<uuid>.json` in the ARTIFACT dir, mounted rw (`src/gateway/run.js:1236`) | yes (file) | P1 |
| Codex remote MCP headers | `<artifact>/run/cg-codex-secrets-<uuid>.json` + `*.headers.cjs` (`src/engines/codex.js:946`) | yes (file) | P1 |
| Composio SDK sessions (Enterprise) | daemon-side bridge over the control socket; container holds only the capability + session URL (`src/ee/composio-sdk-bridge.js`) | no | already correct — the model for P1 |
| Claude login | relay of the access token in `CLAUDE_CODE_OAUTH_TOKEN` (`src/gateway/claude-token-relay.js`) | yes (env) | P2 |
| Codex login | the REAL `auth.json` bind-mounted rw into EVERY channel container, one file shared by all (`src/runtimes/container/credentials.js:14-21`, `lifecycle.js:184`) | yes (file, cross-channel) | P4 |
| SSH developer session | `<artifact>/ssh/users/<id>/{env,mcp.json,codex-secrets.json}` with real values, `/home/agent/.claude/.credentials.json` (access-only), `<artifact>/vscode/claude-token` (`src/gateway/ssh-session.js`, `vscode.js:148`) | yes (files) | P1 + P3 |
| VPN / database helper | credentials only in the helper containers under the gateway root; agent uses `query_channel_database` (`src/gateway/vpn-service.js`) | no | already correct — the model for brokers |
| Network | `--network bridge` hard-coded (`src/runtimes/container/index.js:104`), `NETWORK_POLICY_ENFORCED=false` (`src/engines/network-policy.js:12`) | open egress | P2 |

Nothing in `src/`, `containers/` or `package.json` is an egress proxy today; `mcp-remote/dist/proxy.js`
in `image-paths.js` is the stdio↔HTTP MCP shim, not egress.

## 3. Target architecture

```
container (--network none, lo only)
  process env: GITHUB_PAT=cgph_…  CLAUDE_CODE_OAUTH_TOKEN=cgph_…  HTTPS_PROXY=http://127.0.0.1:3128
               NODE_USE_ENV_PROXY=1  NODE_EXTRA_CA_CERTS/SSL_CERT_FILE/GIT_SSL_CAINFO/… = /run/channelgate/egress/ca.pem
  cg-egress (image helper, started by cg-init): 127.0.0.1:3128 ⇄ /run/channelgate/egress/proxy.sock
  cg-mcp-bridge: stdio ⇄ /run/channelgate/mcp.sock  (gateway tools, composio-sdk, NEW: remote-mcp relay)
        │ per-channel socket dir, bind-mounted read-only; the PATH is the channel identity
        ▼
daemon
  src/gateway/egress/  proxy: CONNECT → TLS-terminate (per-deployment CA) for HTTP(S) →
        allowlist/SSRF policy → placeholder swap (host + header rules, owner liveness) →
        upstream → response scrub → audit event.  Raw CONNECT passthrough per host:port rule
        (22, 5432, 6543) when Allow network is on.  WebSocket upgrade tunnelled after headers.
  src/mcp/socket-server.js  remote-mcp service: daemon dials the streamable-HTTP MCP with the
        real headers; container sees only the capability naming which servers it may reach.
  egress_grants table: placeholder → {scope, channel, owner, secret name, rules, rotated_at}
```

Placeholder format: `cgph_<scope><base32 id>` (≥ 32 random chars). The prefix makes detection in
logs, replies and memory trivial. Engines that validate token shape (Claude Code may check the
`sk-ant-oat01-` prefix) get a shape-preserving placeholder; the spike confirms this.

Rules: a secret's swap rules are `{hosts[], headers[], format}` with formats `bearer`, `raw`,
`basic-password` (git over HTTPS sends `Basic base64(user:TOKEN)`; the proxy decodes, swaps,
re-encodes), `query` and `body` (opt-in, narrowly scoped). Rules come from `cli-catalog.js`
(extended with hosts + headers per provider: GitHub, Vercel, Supabase, Make, Anthropic, OpenAI,
Composio) or from the admin when defining a secret ("used on hosts"). A secret with no rule is
injected raw as today and is **flagged unprotected** in `list_secrets`, the settings UI and the
per-attempt credential inventory; the gateway switch `egressSecretsStrict` (default off at launch,
default on one release later) refuses raw injection instead.

Ownership and liveness at swap time:
- org/channel scope: stable per container generation, baked at container create (exec'd SSH and
  VS Code sessions inherit them); rotation is a live host-side mapping update, no recreate.
- personal scope: stable per (channel, author); injected only into that author's turns and SSH
  sessions; swapped only while the owner has a live run or session in the channel and no other
  person's SSH session is open there. A refused swap returns 403 with a body that names the rule,
  and the turn preamble says personal secrets are paused.
- the Claude relay: per run, exactly as today, but the container-side value is a placeholder.

## 4. Phases

Each phase is its own worktree and branch from `origin/beta`, lands with tests, `FEATURES.md`,
`TEST-PLAN.md`, `CHANGELOG.md` and the docs it touches. Order is fixed; each phase is
independently shippable.

### P1 — Remote MCP auth behind the socket bridge (`feat/mcp-relay`)

Generalize the Enterprise `composio-sdk` service in `src/mcp/socket-server.js` into a
`remote-mcp` service: the container-side bridge sends the capability and a server name; the
daemon dials the streamable-HTTP MCP with the real headers and pipes MCP frames. The capability
gains a `remoteMcps[]` claim (server name + URL, bounded like `composioSessions`) so the bearer
alone fixes what a run may reach.

- `src/gateway/mcp.js` + `run-integrations.js`: every header-bearing remote server (Composio
  legacy user/agent, toolbox, Make, credentialed catalog servers) becomes a `command` entry over
  the bridge; `cg-mcp-*.json` carries no token.
- `src/engines/codex.js`: drop the secrets bundle and header helpers for remote servers; Codex
  reaches them through `secret-env-bridge → cg-mcp-bridge` exactly like the gateway server.
- `src/gateway/ssh-session.js`: `mcp.json` and `codex-secrets.json` lose their tokens; the SSH
  capability (12 h) carries the same claim.
- stdio catalog MCPs that need a credential keep running in the container; their secret becomes a
  placeholder in P2. No MCP sidecar container.
- Tests: `test/socket-server.test.js` (relay auth, claim bound, wrong server refused),
  `test/mcp-config.test.js` (materialized config contains no token), Codex `-c` args contain no
  token, SSH prepare writes no token. Live gate: a Composio tool call on Claude and on Codex
  through the relay in a container; the artifact dir grepped for token strings during the run.

### P2 — Egress proxy, placeholders, `--network none` (`feat/egress-proxy`)

Spike first (one week, throwaway branch): Node CONNECT + TLS-terminating proxy over a Unix socket;
prove Claude Code streaming turn, Codex turn (incl. its WebSocket transport), `gh api`,
`git clone` over HTTPS with a placeholder PAT, `vercel whoami`, `agent-browser` on an HTTPS page
with the CA via `--ignore-certificate-errors-spki-list`, SSE and chunked bodies unbuffered, HTTP/1.1
only via ALPN. Fail → iron-proxy fork behind the same transport.

Then:
- `src/gateway/egress/` (server, CA store under `~/.channelgate/config/egress-ca/` 0600,
  rules, swap, scrub, audit) and `containers/bin/cg-egress` (Node forwarder from `src/`, staged by
  `build-image.mjs`; `/run` is `noexec` so it lives under `/opt/channelgate/bin`).
- `src/runtimes/container/lifecycle.js`: `--network none`; per-channel socket dir
  `~/.channelgate/run/channels/<slug>/` mounted read-only at `/run/channelgate/egress`
  (`mcp.sock` stays global); proxy + CA env and `AGENT_BROWSER_ARGS` at create; `network` stays in
  the create-time fingerprint; an admin-grantable **raw bridge** variant per channel remains for
  genuine raw-socket needs (`ping`, arbitrary TCP), reported honestly in `run_config` and the
  preamble.
- Migration 30: `egress_grants`. `src/config/channel-env.js` + `scoped-env.js`: resolve to
  placeholders; `cli-catalog.js` gains hosts + headers per provider; new secret UI field "used on
  hosts". Reserved-name set already covers the proxy and CA variables (`child-env.js:29-40`);
  add `NODE_USE_ENV_PROXY`, `AGENT_BROWSER_ARGS`, `SSL_CERT_*`, `*_CA_BUNDLE`, `GIT_SSL_CAINFO`.
- `src/gateway/claude-token-relay.js`: container value becomes a placeholder swapped on
  `api.anthropic.com`; warm-pool fingerprint keys on the placeholder generation.
- Policy: Allow network **on** = pass-all through the proxy except private/link-local/metadata
  ranges (checked against resolved IPs at CONNECT time, DNS-rebinding safe) with every
  destination audit-logged; **off** = only the engine endpoints and relayed MCPs. Raw CONNECT
  passthrough to ports 22/5432/6543 for hosts the channel declares (Supabase, GitHub SSH) when
  on. `NETWORK_POLICY_ENFORCED = true`.
- `src/util/redact.js`: real values remain redacted (they should never appear); placeholders are
  not secrets and are left alone. Response bodies of text content types are scrubbed for real
  values as defense in depth.
- Background jobs, schedules, API runs and the memory reviewer resolve placeholders at their own
  spawn as today (`background.js:455`).
- Tests: unit (CA mint per SNI, header swap incl. basic-password, wrong-host no-swap, owner
  liveness refusal, SSRF deny, response scrub, WebSocket tunnel), `container-cli.test.js` and
  `container-lifecycle.test.js` flipped from "never none" to "always none + socket mount",
  `network-policy.test.js`. Live gates (`CG_LIVE_CONTAINER=1`): the spike list above on Claude and
  Codex; bypass proof from inside a container — `curl --noproxy '*' https://example.com` fails,
  `getent hosts example.com` fails, `/proc/net/dev` shows only `lo`, connecting to the podman
  bridge gateway IP fails; a placeholder sent to a non-declared host arrives unswapped; a rotated
  secret is live without recreate.

### P3 — SSH and VS Code sessions on the same handles (`feat/ssh-placeholders`)

- `src/gateway/ssh-session.js`: the `env` file exports placeholders; `.credentials.json`
  (access-only) holds the placeholder relay token so interactive Claude Code still shows plan
  facts; `<artifact>/vscode/claude-token` is removed (it is not cleared on release today,
  `vscode.js:161`); the session note names the proxy, the CA and the personal-scope pause rule.
- Outbound SSH from a session (`git@github.com`): a `ProxyCommand cg-egress-connect %h %p`
  helper doing raw CONNECT to declared hosts on port 22. The proxy cannot inject an SSH key;
  outbound keys are a later restricted ssh-agent broker (destination-constrained, OpenSSH
  `agent-restrict`), out of scope here and documented as such.
- `docs/SSH-ACCESS.md`: `-L` forwards to external hosts no longer work under `--network none`;
  forwards to container-local ports and `-R` are unchanged; VS Code server downloads for unlisted
  client versions go through the proxy env.
- Tests: SSH prepare writes no real value anywhere under the artifact dir; personal placeholder
  paused while a second person's session is open; release removes everything. Live gate: a
  developer session runs `vercel whoami` and `gh api user` with placeholders; `printenv` shows
  only `cgph_` values.

### P4 — Engine login refresh and the end of raw fallbacks (`feat/engine-auth-broker`)

- Codex: replace the shared rw `auth.json` mount with a per-container access-only file holding a
  placeholder; the daemon owns refresh in the engine home (twin of the Claude relay,
  `src/engines/codex-auth.js`), and the proxy intercepts the token-refresh endpoint so a refreshed
  real token never lands in the container. Spike required: Codex's refresh path and
  `codex login --with-access-token` behavior at the pinned version. Until then the shared mount is
  documented as the remaining cross-channel credential exposure.
- Flip `egressSecretsStrict` default on; `list_secrets` reports the remaining raw (unruled)
  secrets as a finding rather than a state.
- Retire `remote-secret-bridge.js`'s outdated "sandbox-denied gateway root" comment and any
  code path that could reintroduce a raw-secret file under the artifact dir (a static check in
  `scripts/static-check.mjs`: no write under `artifactDir` of a value that came from a secret
  resolver).
- Later, only if a customer requires strict per-person isolation: an opt-in per-developer
  sidecar container for SSH sessions (same image, own HOME volume, same work-folder mount). Not
  planned; recorded here so it is not re-designed.

## 5. What this does not solve (say it in the docs)

- Authorized misuse: a member with a live handle can do anything the real credential allows on its
  declared hosts. Scope the credential at the provider; the proxy adds destination + header
  scoping and an audit trail, not permissions.
- Credentials minted by an authorized API (a GitHub installation token returned in a response) are
  real values the response scrub may not recognise. Provider-aware scrub rules are best effort.
- Request-signing schemes (AWS SigV4) cannot be swapped; such secrets stay raw and flagged.
- Raw TCP protocols (Postgres, SSH) carry their own auth; passthrough exposes the destination, not
  a hidden credential. Database passwords remain raw and flagged unless the VPN/database helper
  pattern is used.
- `/sudo` host threads and the operator-home mount deliberately bypass all of this.

## 6. Divergences from the private 2026-09-01 roadmap (§P3), for the record

- Always `--network none` + Unix-socket relay instead of a proxy-only podman network with the proxy
  on the bridge gateway: no network path exists to bypass, and mode flips are still live because
  the mode is proxy policy, not container networking. The raw-bridge admin variant is kept.
- Node in-house proxy instead of the upstream iron-proxy binary, with the spike gate above.
- Org/channel placeholders baked at create as the roadmap says; personal placeholders are
  per (channel, author) with owner-liveness gating, which the roadmap did not cover.
