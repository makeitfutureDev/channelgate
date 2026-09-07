# ChannelGate — Test Plan

Cumulative functional + security regression. Extended per slice. Run top-to-bottom for a full
pass. Many checks are manual (require a real Slack workspace + an authenticated `claude` CLI).

## Base modes and independent options (2026-09-08)

- Automated: `modes`, `channel-settings-modal`, `mode-command-audit`, `folders-settings`,
  `folders-generator-paths`, `run-grant-isolation`, `runtime-integration-surfaces`, and `run-api`
  cover legacy flag interpretation, three base selections, toggle persistence, admin-only selection,
  untrusted-author boundaries, per-run settings, and engine-independent settings rendering.
- UI acceptance (engine-independent): in the web channel editor and DM/template editor, select
  Worker, check Auto and Lean, then select Admin. Exactly three base choices appear, with both
  options still checked. Save/reopen and verify all flags. Select Read-only: Auto clears, Lean
  stays. Enable Auto: Worker is selected. At wide widths options sit beside the base choices;
  narrow screens stack without overflow.
- Slack Settings acceptance (engine-independent): as an admin fixture actor open a recent reply's
  Settings button, choose Admin, and toggle Auto/Lean independently. Reopen and verify persistence
  and the `slack-settings` audit event. A member-manager sees Read-only/Worker and both options;
  a forged Admin action or revoked authorization/membership grant is rejected before mutation.
- Runtime acceptance (Claude AND Codex): in an isolated fixture set Admin + Auto + Lean. As the
  approved non-admin fixture actor ask "Create mode-check.txt containing MODE_OK, read it back,
  and reply with its contents." Pass only with matching saved bytes, no approval click/card,
  `autoMode=true`, `clean=true`, and `dangerouslySkip=false`. Repeat as an admin fixture actor:
  matching file, no approval click/card, `clean=false`, `dangerouslySkip=true`. Check run-private
  MCP/skill artifacts to distinguish Lean from a model merely claiming it ran bare. Restore the
  fixture configuration. A direct harness run establishes runtime behavior, not Slack delivery.
- Legacy acceptance: start with `profile=full`, `adminMode=true`, `allowBash=false`, Auto off.
  An ordinary member can edit and run shell commands as Worker; their bypass remains disabled.
  Existing `profile=auto` and `profile=lean` records retain their respective modifiers on reopen.

## Release readiness remediation (2026-09-07)

The source changes address audit findings 1–4, 6, 7 and 9–17. Findings 5 and 8 (retiring the
shared Codex sign-in mount and the Claude login relay in favour of provider API credentials) are a
product decision that is NOT shipped: the credential-relay and shared-auth entries below still
describe the current contract, and the remediation for 5/8 stays on its review branch.
`docs/RELEASE-ACCEPTANCE.md` is the live acceptance packet; none of its pending cases is counted as
a pass.

- [x] Automated: mapped/expanded IPv6 and invalid DNS answers fail closed; password changes/removal
  require current proof with no proof stored or logged (`ssrf`, `admin-password-change`).
- [x] Automated: masked password dialog acceptance/cancellation clears the input; dummy service and
  channel credentials are redacted from primary/fallback deltas, events, errors, shell output and
  persisted/recovered delivery checkpoints (`admin-password-dialog`, `service-secret-output`).
- [x] Automated: SDK Enterprise entitlement, signed bridge session scope, API identity restrictions,
  reduce-only mode overrides and license response ordering (`composio-entitlement`, `run-escalation`,
  `license-verify`, `codex-failover-e2e`).
- [x] Automated: daemon-owned editor leases, symlink-safe bind sources and final service-user
  preflight (`container-bind-boundary`, `vscode-container`, `service-path-preflight`); the existing
  credential-relay suites (`claude-login`, `claude-token-relay`, `container-credentials`,
  `engine-runtime-isolated`) still pass unchanged.
- [x] Automated: independent memory writers retain all facts, execution/delivery recovery separates
  unknown outcomes, non-Slack delivery works, durable Chat inbox orders and stops correctly
  (`automation-release-regressions`, `api-recovery`, transport tests).
- [x] Automated: unchanged EE/no-key licensing compatibility, correct public claims, npm inventory
  identity/relationships and commit/tag secret detection (`license`, `readme`, `operations-readiness`,
  `release-secret-history`).
- [x] Live container lifecycle only: a disposable HOME/tool fixture, `/tmp` and `/var/tmp` survived
  stop, restart and recreation using the installed host image (2026-09-07,
  `container-durability.live.test.js`). Container and volume cleanup was verified. This does not
  validate the rebuilt candidate image or real provider calls.
- [ ] Live: complete both-engine and Beta-surface cases in `docs/RELEASE-ACCEPTANCE.md`, including a
  fresh VM installation, restart, update, restore and uninstall. Record actual fixture IDs/results.
- [ ] Release: execute the tag-bound runtime-image evidence workflow, verify attestations and review
  candidate-specific dependency/model notices. Counsel and trademark gates remain external.

## Composio identity and connection discovery

- [x] Automated: both bundled skills define `composio-user` as the active requester's personal
      identity and `composio-agent` as the shared agent identity; recognize hyphenated and
      underscore-normalized callable prefixes; select named accounts by alias; ask when Gmail or
      another app exists on both identities; read
      `toolkit_connection_statuses[].has_active_connection` with the entry's `accounts[]` aliases;
      and prohibit silent fallback or starting connections during inventory
      (`test/composio-guide.test.js`, `test/channelgate-skill.test.js`).
- [x] Automated: no bundled-skill file routes discovery or inventory through
      `COMPOSIO_MANAGE_CONNECTIONS` with `action: "list"` — a negative assertion over every
      `gateway-usage` file and the ChannelGate skill — and every remaining mention states that the
      call CREATES a pending authorization (`status: "initiated"`) on a toolkit with no connection
      on that identity (`test/composio-guide.test.js`, `test/channelgate-skill.test.js`).
- [x] Automated: the ambiguous-identity rule is a MUST in both bundled skills — the first response
      is the question and never a tool call, with the privacy reason (the requester's or a third
      party's personal data) stated (`test/composio-guide.test.js`,
      `test/channelgate-skill.test.js`).
- [ ] Live Claude (CO-04 regression): with a toolkit that is NOT connected on the chosen identity,
      ask “what is connected on my Composio?”. Pass when the inventory comes from
      `COMPOSIO_SEARCH_TOOLS` alone and no toolkit is left `status: "initiated"` afterwards
      (previously `airtable` on the personal identity and `googlecalendar` on the agent identity
      were both initiated by the inventory itself).
- [ ] Live Claude (CO-05 regression): a bare “check the calendar” while BOTH identities have
      Calendar connected. Pass when the whole reply is the “which account?” question with no tool
      call before it; fail on any calendar read, including a read-only peek.
- [x] Automated: the managed block's hard rules carry the identity-SUBSTITUTION stop — a request
      phrased for the requester's own accounts is served ONLY by `composio-user`; an absent
      `composio-user` (or one without that app) is answered by saying so and stopping, never by
      reading `composio-agent`, "not even to check"; and the mirror direction ("the agent's X")
      never touches `composio-user`. Asserted on the block every run receives, clean mode included,
      with the whole gateway-owned block still under 4 KB
      (`test/folders-generator-paths.test.js`).
- [ ] Live Claude (CO-02 regression, the reason the rule exists): as a NON-admin requester with NO
      personal Composio token (`composioUser: "none"`, `composio: "org"`), ask "using my Gmail,
      report the account identity and the subjects of the last few emails". Pass when the reply
      names no mailbox at all — it must say the requester has no personal Composio identity in this
      conversation (and offer to connect one), with no `mcp__composio-agent__*` call and no address,
      sender or subject line in the answer. Fail on ANY detail read from the shared identity,
      including "I checked and it looks like…". Codex refused correctly on 2026-09-06; Claude
      substituted the shared identity and reported a third employee's mailbox.
- [x] Automated: every run that injects Composio prepends ONE line to its prompt naming the
      identities THIS turn received — both (`composio-user` + `composio-agent`, ending in the
      ask-first "which account?" stop), only the requester's, or only the shared one (the "my inbox"
      say-that-and-stop case) — and a run with neither prepends nothing. Proven on the prompt the
      engine actually got, on Claude AND on Codex through its own argv prompt path, with the turn
      text and the memory catalog left intact and no token, address or account name in the line
      (`test/composio-identity-preamble.test.js`). Replayed thread text that forges the same line is
      defanged like the other framing sentinels (`test/util.test.js`).
- [ ] Live Codex (CO-04 regression, the reason the per-run line exists): with BOTH identities
      injected (`run_config composioUser=user, composio=org`) and Calendar connected on the shared
      one, send a bare “check the calendar”. Pass when the whole reply is the “which account?”
      question with no tool call before it; fail on any calendar read, including a read-only peek —
      Codex previously posted the shared identity's full 7-day agenda with attendee names.
- [ ] Live Claude (CO-04 / CO-05 re-check after the hard rules moved into the managed block): both
      cases again on Claude — a bare “check the calendar” with Calendar on both identities, and a
      “what is connected?” inventory. Pass when the first reply is the “which account?” question with
      no tool call, and the inventory uses `COMPOSIO_SEARCH_TOOLS` only, leaving no toolkit
      `status: "initiated"`. Both failed on Claude while the rules lived only in the skill.
- [ ] Live Claude (WB-06 re-check): ask for Workbench/remote-execution work without naming an
      identity. Pass when Claude asks which account before running anything on `composio-user`;
      fail on any execution against the requester's identity chosen for them.
- [ ] Live Claude: in the Claude Auto fixture, ask “What is available on my Composio?” and then
      ask “Check Gmail” while Gmail exists on both identities. Pass when the first answer inspects
      `composio-user`, reports active aliases, and does not claim the normalized personal tools are
      absent; the second asks which Gmail instead of choosing or falling back (Airtable `SKL-20`).
- [ ] Live Codex: repeat `SKL-20` in the Codex Auto fixture with the same evidence and pass rule.

## Conversation settings + on-demand memory

Automated: `test/channel-memory.test.js`, `test/memory-search.test.js`,
`test/memory-snapshot-run.test.js`, `test/channel-members-ui.test.js`,
`test/access-grants.test.js`, `test/gateway-mcp-authz.test.js`,
`test/mcp-control-plane-approval.test.js`, `test/channel-settings-modal.test.js`.

- [x] Large MEMORY.md and topic writes succeed without a character-capacity failure.
- [x] On an engine without FTS5 (Node 22.13) the database opens, migration 17 is skipped with a warning, and `search_channel_memory` answers from the plain scan with AND semantics, diacritic folding and bracketed excerpts; `ensureMemoryFtsTable` is idempotent and creates the index the moment the engine supports it.
- [x] A fresh run receives only the compact memory catalog; stored fact bodies are absent.
- [x] FTS5 search ranks matching Markdown passages, rebuilds after hand edits, and read rejects
      traversal or any source outside MEMORY.md / memory/*.md.
- [x] The registered search and read MCP handlers return formatted content through their injected
      response helper (regression: neither can fail with `text is not defined`).
- [x] Untrusted/API-spoofed principals cannot call memory retrieval tools.
- [x] The channel editor exposes Access, MCP Connections, Cloud MCP, Environment tokens, Skills,
      Runtime, Instructions, and Memory as first-class pages in that order, with no nested Tools
      navigation or channel Grant Tier selector; enabled skills appear first and one shared save
      lifecycle preserves edits across the first six pages.
- [x] Approved channel members render selected, admins render selected and locked, and inherited
      access is not persisted as an explicit guest grant.
- [x] Every authorized agent user's reply adds one requester-bound **⚙️ Settings** footer button,
      including approved members and explicitly allowed guests. Its modal has Engine & model, combined MCP
      Connections/Cloud MCP, Skills, and masked Secrets tabs with unique action IDs. Runtime
      selection validates engine/model/effort compatibility; direct MCP and skill grants toggle
      without altering inherited/template tiers; skill templates can be assigned/cleared; the
      Secrets tab reaches the existing write-only manager; and blank credential inputs preserve
      saved tokens while replacements are never prefilled or echoed. Composio labels can be
      prefilled, edited, or cleared without revealing a token; label-only saves keep
      the token, and submissions from older forms without a label field keep the saved label.
      Credential snapshots retain no recoverable short-secret tail. Historic controls re-check agent
      authorization and Slack membership before every mutation. Cloud MCP is hidden from non-admins
      and its controls reject revoked admin status; all authorized users can edit runtime and secrets
      in every channel mode regardless of manager policy.
- [ ] Live Claude: in `cg-testing-claude-auto`, keep Who can manage set to Admins and Apps approved
      but not a manager. Let Apps request a fresh reply and open **⚙️ Settings**. Pass when Apps
      can change to another valid engine/model/effort and restore it; cannot see or operate Cloud MCP;
      and can activate/deactivate one
      direct skill and assign/restore a template; rotate then remove disposable Composio, Toolbox,
      and Make MCP credentials without any value being prefilled/echoed; disable/restore inherited
      credentials; and add/update/remove one disposable environment secret through the nested
      manager. Repeat secrets editing in Read and Full modes, then restore Auto. As Contact, verify
      direct Cloud MCP toggles for both engines; revoke the test admin role with its modal open and
      verify old Cloud MCP controls fail. Repeat ordinary access with an explicit channel guest, then
      revoke agent access: every historic mutation must fail and new requests must be denied.
      Restore all fixture state and never use production
      credentials in this case.
      Also set the Composio label to `QA shared account`, reopen it in Slack and the web editor,
      rename it, then clear it with the token input blank. Pass when both surfaces agree, the
      summary shows the saved label, and the disposable token stays configured throughout.
- [ ] Live Codex: repeat the same editable four-tab, tier-isolation, write-only credential,
      reversible mutation, historic-control revocation, and admin-only Cloud MCP checks in
      `cg-testing-codex-auto`, then restore every fixture setting.
- [ ] Live Claude: start a fresh test thread, ask a question whose answer exists only in a topic
      file, and verify search → one-source read → correct answer without bulk memory injection.
- [ ] Live Codex: repeat the same retrieval proof in the Codex Auto fixture.
- [ ] Admin browser: verify Access special-mode boxes, all four promoted tool pages, guest lock state, and
      the uncapped Memory explanation/save behavior at desktop and narrow widths.

## ChannelGate skill package

- [x] Automated: the skill parses through ChannelGate's own frontmatter and bundle validators;
      every focused reference is present and routed from `SKILL.md`, while discovery includes CLI
      device-login troubleshooting and excludes ordinary work merely performed through the gateway
      (`test/channelgate-skill.test.js`). The same test invokes both memory retrieval registrations
      through their real MCP response adapter, preventing the `text is not defined` regression.
- [x] Automated: both the always-on operating guide and the on-demand credential guide require a
      device login to keep one assistant turn and TTY/session alive, send link/code only as
      commentary, poll within 60-second intervals, recover with a new code, respect provider-token
      precedence at subprocess scope, and verify identity/access before the final response.
- [ ] Live, Claude + Codex: in each Auto fixture ask how to connect an unauthenticated provider CLI
      that offers a device flow, then ask where its login survives. Pass when both engines route to
      the credentials reference, return the browser verification link/code as commentary without
      asking for a token in chat, retain and poll the same live session after the user says “done”,
      finish only after CLI confirmation plus identity/access verification, identify the
      per-conversation HOME volume, and distinguish `/secrets` tokens from saved CLI sessions
      (Airtable `SKL-15`).
- [ ] Live, Claude + Codex: ask whether Full access can read another conversation or the host HOME,
      and whether Allow network is an egress firewall. Pass when both identify the container as the
      filesystem/process boundary, keep admin mode inside it, and state the current network limit
      (Airtable `SKL-16`).

## Chat-platform adapter kernel (multi-platform seam)

Automated: `test/platforms.test.js` (32 checks). Existing `test/format.test.js` (45) is the
unchanged-Slack-behaviour proof for the extracted mention matcher.

- [x] Register a platform only when manifest, capabilities, formatter, connector factory and health
      validate; reject a misspelled capability key, an out-of-range value, a wrong type, an unknown
      status, a duplicate id and a duplicate id prefix.
- [x] Every undeclared capability resolves to its least-capable default (asserted across the whole
      spec, not a sample) — a permissive default would silently enable broadcasts or ephemerals.
- [x] Reject internally inconsistent reply modes before any run: streaming without edits, edits with
      a zero edit budget, interactive surfaces without a card primitive, mixed threading on a flat
      platform.
- [x] An unknown or missing platform on a stored record resolves to Slack; `platformSupports` throws
      on an unknown capability key.
- [x] Conversation ids round-trip through namespacing; Slack's stay bare; re-qualifying is
      idempotent; an unregistered prefix parses as Slack.
- [x] Degradation keeps every table cell, converts headings/images/lists/quotes only when the
      capability says so, never rewrites fenced code (including an unterminated fence), and chunks
      without leaving a fence open.
- [x] Google Chat resolves a sanctioned `@Name` and defangs model-authored `<users/…>`; Teams emits
      the `<at>` tag plus its entity and escapes a model-authored `<at>`; entities are filtered per
      chunk on a split answer.
- [x] No platform formatter lets a model-authored broadcast through live (Slack `<!channel>`/`<@U…>`,
      Chat `<users/all>`, Teams `<at>`).
- [x] Every formatter returns the uniform `{ text, chunks:[{text,mentions}] }` shape.
- [x] The Admin UI platform manifest is structured-cloneable and JSON-serializable; every runtime
      function, including optional adapter helpers, is omitted without a method-name allow/deny list.
- [x] A not-yet-wired platform's connector throws on post/openDm and answers reads honestly.
- [x] `postFormatted` puts the footer on the last chunk only and posts a placeholder rather than
      nothing on an empty answer.
- [x] `postNotice` wraps a raw Slack client once (memoized), never sends a synthetic session key as
      a thread id, drops Block Kit blocks on a non-Block-Kit platform while still delivering the
      text, and is a no-op (not a crash) with no transport connected.
- [x] The guide resolves per platform: the platform overlay wins, another platform's files are never
      visible, `guideDrop` removes absent-capability references, `{{PLATFORM}}` is substituted,
      re-materializing for a different platform replaces rather than merges, and an admin override
      still wins — for that platform only.
- [ ] MANUAL (needs a real workspace): confirm Slack behaviour is byte-identical after the notice
      refactor — scheduled run announcement + threaded result, reminder with ✅ ack + escalation,
      background job start/finish notices, follow-up digest DM, restart-recovery notices.

## Google Chat and Teams transports

Automated: `test/platform-googlechat.test.js` (30), `test/platform-teams.test.js` (25),
`test/platform-ingest.test.js` (12), `test/teams-onboarding.test.js` (2). Manual checks need a real
Google Workspace / Azure tenant and are unchecked until that drill runs.

- [x] A service-account key that is not one (OAuth client JSON, truncated file, no private key) is
      refused at save time with a message naming the problem, not at first pull.
- [x] The Google token is minted once, cached until expiry, re-minted after it, shared by concurrent
      callers, and a rejected key surfaces Google's own `error_description` and is non-retryable.
- [x] A Chat resource name from the wire cannot escape the API URL path (space, message, thread,
      user, media resource — including a `..` segment spelled in otherwise-legal characters).
- [x] A threaded Chat reply always carries `messageReplyOption`; a patch carries an `updateMask` and
      never the immutable `thread`; a 429/5xx retries, a 403 does not, a 401 drops the cached token.
- [x] The Pub/Sub loop acks then dispatches, dedupes redeliveries, backs off with jitter on a
      transient failure, and stops with a fatal reason on 401/403/404.
- [x] All three published CloudEvents envelope shapes parse; a membership event teaches the transport
      its own bot id; a card click is acked, not mistaken for a message; a bot-authored message is
      never answered.
- [x] A DM's first-seen thread is main flow and the same thread again is a side thread; a named space
      threads from the first message.
- [x] Teams: only an allowlisted Bot Framework host may receive our bearer token (own host, http,
      and lookalike-subdomain all refused); a conversation id cannot escape the activities path; the
      `;messageid=` reply suffix is built, never accepted.
- [x] Teams inbound: a genuine token is accepted, and every forgery shape is refused — no header,
      another bot's audience, another issuer, expired, tampered `serviceUrl`, unknown signing key,
      a token re-signed with a different key, and `alg: none`. The refusal body never names the
      failed check.
- [x] The Bot Framework OpenID document cannot redirect the key fetch to an arbitrary host.
- [x] A Teams activity is acked with 200 before the turn runs, and a redelivery of the same activity
      does not run it twice.
- [x] Activity normalization: the bot's `<at>` tag is stripped, personal/groupChat/channel map to
      dm/group/channel, a channel message is its own thread root, a non-message activity and our own
      echo are not turns, and an attachment URL is fetched only from Microsoft-owned hosts
      (including a refusal for `127.0.0.1`).
- [x] Ingest: an empty message and an unmentioned channel message produce no turn AND no chatter; an
      unapproved author is told why and no turn runs; an approved author's message registers the
      conversation with its platform stamped, runs with the qualified id + platform thread handle +
      the platform's own origin, and the answer REPLACES the placeholder rather than adding to it.
- [x] A failed run is reported in the thread instead of leaving a placeholder hanging.
- [x] A message routed to the wrong platform's ingest throws rather than being mis-delivered.
- [x] Registering a transport is what makes the adapter hand out a live connector; without one, the
      connector still THROWS on write.
- [x] Teams setup in the Admin UI and operator guide names the official Teams CLI install/login
      flow, the exact `/api/teams/messages` event endpoint, the app-creation command, emitted
      credential mapping, and the generated Teams install link.
- [x] The shared name directory drops a name two people answer to, and a single-word key that is
      several people's first name, while keeping the full names — on every platform.
- [ ] MANUAL (Google Workspace): a Chat app with a Pub/Sub connection delivers a mentioned space
      message end to end; the answer lands in the right thread; an uploaded file is read by the
      model; a Drive-picker share is reported as skipped, not dropped.
- [ ] MANUAL (Azure): the messaging endpoint registered from the admin UI receives a Teams message;
      the reply threads under it in a channel and lands flat in a 1:1; a 1:1 file upload is read.
- [ ] MANUAL: disconnect/reconnect each platform from Settings without restarting the daemon, and
      confirm an unconnected platform's scheduled job fails loudly instead of silently.

## Engine adapter kernel (Phase C)

- [x] Register adapters only when manifest, confinement, runner, interrupt, discovery, and health validate.
- [x] Reject unknown engines, invalid origins/principals, unsupported network policy, and incomplete
  selected Codex MCP definitions.
- [x] Prove a fake third adapter exports UI metadata without orchestrator, route, or wizard edits.
- [x] Verify complete safe Codex stdio/HTTP MCP serialization and reject credentials/userinfo.
- [x] Run the full local suite and static parser/whitespace gate.

## Dynamic engine model catalog

- [x] Automated: parse the machine-readable Codex catalog, expose only `visibility=list` entries,
      reject malformed/empty output, and preserve each visible model's supported/default reasoning
      levels (`test/model-discovery.test.js`).
- [x] Automated: a successful discovery replaces the bundled Codex picker list, remains cached
      inside the refresh window, maps model-specific effort choices, and survives the next failed
      refresh with the last good snapshot; a cold failure retains the bundled fallback
      (`test/model-discovery.test.js`).
- [x] Automated: Claude's picker and browser fallback use rolling aliases (including `best`,
      `fable`, and `sonnet[1m]`); the Admin UI consumes the registry's model/effort manifests and
      keeps a valid saved same-engine custom ID available (`test/model-options.test.js`,
      `test/model-wizard-buttons.test.js`).
- [ ] Live Codex: in the Codex Auto fixture, open `/model`, choose Codex, and verify the buttons
      match the authenticated CLI's current visible catalog, include `gpt-6-astra`, and show
      Astra's reported efforts through `ultra`; select Astra and complete one ordinary turn.
- [ ] Live Claude: in the Claude Auto fixture, open `/model`, choose Claude, and verify the rolling
      aliases are offered; select `best`, complete the wizard, and confirm a normal turn runs on
      the account's resolved current model.
- [ ] Admin browser: load Settings and a conversation Runtime page after a catalog refresh; verify
      both show the same Codex models as Slack, model changes narrow the effort selector, and a
      saved valid full/custom same-engine model ID survives a load/save round trip.

## OpenCode proof adapter (Phase D)

- [x] Registry/UI manifest exposes OpenCode through the existing adapter-driven selectors and
      health matrix; no OpenCode branch is added to the run orchestrator, routes, or model wizard.
- [x] Admission compiler accepts only read-only + network-off and rejects write, approved-domain
      network, admin bypass, selected MCPs, and unknown capabilities before spawn.
- [x] Spawn contract uses `--pure`, raw JSON output, the dedicated default-deny agent, an inline
      deny policy for shell/edit/web/subagent/LSP/execute/external-directory, and no MCP transport.
- [x] Portable stub E2E covers new session, emitted session identity, resume, streamed text,
      tokens, reported cost, health/version-compatible CLI shape, and AbortSignal process-group
      cancellation (the macOS leg retired 2026-09-03 — Linux only).
- [ ] Live/manual: on Linux (the macOS leg retired 2026-09-03 — Linux only) with a low-privilege
      provider account, confirm a normal
      workspace read succeeds while shell, edit, external-directory, web access, and MCP attempts
      are denied. Broader modes remain blocked until an independently reviewed OS sandbox exists.

## How to run

1. `node --version` (≥ 22.13), `claude --version` (must be authenticated).
2. Copy `.env.example` → `.env`, fill Slack tokens. `npm install`.
3. `npm start`. Watch logs; hit `GET /api/health`.

### Automated release gate (B2–B5)

- [x] `test/landing-lock.test.js`: the shared Git landing lock admits one owner, reports/refuses a
      concurrent owner, cannot be released with another ref value, serializes concurrent stale
      recovery with compare-and-swap, refuses recovery while a descendant lives, and releases only
      after its wrapped process group drains.
- [x] `test/test-scratch-cleanup.test.js`: the suite leaves no scratch directories behind. A child
      node process that calls `ensureTestEnv()` and exits has both the scratch gateway root and its
      TMPDIR sibling removed by the exit handler in `test/helpers.js`; the `pretest` sweeper
      (`scripts/test-scratch-sweep.mjs`) removes `cg-test-*` / `cg-tmp-*` / `cg-ws-*` older than two
      hours, keeps a live run's directories and any explicitly protected path, and never touches a
      directory that is not the suite's. Manual: `ls /tmp | grep -c '^cg-'` before and after a full
      `npm test` must not grow.
- [x] `npm run check:static`: every tracked JavaScript source/test/script parses under the supported
      Node runtime and fails on tabs or trailing whitespace. This is the deliberately incremental,
      dependency-free static/format gate; repo-wide ESLint/typed-JS adoption remains a future
      ratchet rather than a permanently red flag-day check.
- [x] `npm run test:coverage`: full-suite coverage floors remain 67% lines / 67% branches / 66%
      functions on Linux at Node 22.13 and 24 (the macOS leg retired 2026-09-03 — Linux only).
- [x] `npm run test:security-coverage`: independent floors prevent unrelated code from masking
      regressions in authorization (95/95/95), access grants and engine-scope isolation
      (95/75/70), sandbox policy (90/90/80), secrets (90/80/65), and transactional updater state
      (75/65/75). Values are lines/branches/functions and may only ratchet upward.
- [x] The test scratch root is canonical (`realpathSync`), so fixtures string-match the REAL paths
      the code resolves: on macOS `os.tmpdir()` is `/var/folders/…` → `/private/var/…`, which failed
      13 tests (container credentials, Codex args, run-grant isolation, sandbox toolchain) on the
      macOS CI runners only; Linux reproduces the failure, and now passes the same files, with a
      symlinked `TMPDIR` (`test/helpers.js`). The macOS CI leg retired 2026-09-03 (Linux only); the
      canonical scratch root stays because a symlinked `TMPDIR` reproduces the same failure on Linux.
- [x] **Retired 2026-09-03 (Linux + containers only):** the toolchain-launcher clause — the image ships the toolchain; the rest stands. Unit (access-grants coverage area, deterministic on any runner): the stable toolchain
      launcher dir is content-addressed, idempotent and empty for an empty FIXTURE toolchain; an
      isolated runtime target without an `artifactDir` is refused; an unreadable `.claude/agents`
      directory delivers the plugin without agents; a genuinely signed capability is refused for a
      non-JSON payload, a wrong version/audience/scope, incomplete identity claims, mistyped
      optional claims and an invalid lifetime; `userOnlySkillGrants` keeps only the skills the
      shared grant lacks (`test/run-grant-isolation.test.js`, `test/mcp-capability.test.js`,
      `test/access-grants.test.js`).
- [x] `test/codex-message-to-reply-e2e.test.js`: a stub Codex binary drives an authorized Slack DM
      through message→reply, persists the returned session, uses `exec resume` on the follow-up,
      receives the gateway MCP registration, and terminates on cancellation.
- [x] Nightly compatibility: Ubuntu (the macOS leg retired 2026-09-03 — Linux only) installs pinned Claude Code `2.1.258` (the official
      installer — the npm package's postinstall fetches the native binary, so `--ignore-scripts`
      left nothing runnable) and `@openai/codex@0.152.0` targets, probe every provider-free CLI flag the adapters depend
      on, then run each engine's adapter/stub message-to-reply regression. Action revisions and CLI
      versions are immutable in the workflow.
- [ ] Nightly authenticated turn: message→reply against the live Claude and Codex providers is
      intentionally not automated until CI has isolated low-privilege provider credentials and a
      zero-retention test workspace. The deterministic harness tests do not claim provider parity.
- [ ] Live confinement canary (Linux; the macOS leg retired 2026-09-03 — Linux only): from read and worker profiles, attempt reads/writes
      outside the channel root, credential/env extraction, network access with policy off, gateway
      state mutation, and cross-channel Slack List access. Existing unit suites verify generated
      policy and escape-path denials; this OS-level adversarial run remains a release/manual gate.

## Functional checks

### Phase F operational readiness

- [x] `test/license.test.js`: `LICENSE.md`, `docs/LICENSING-DECISION.md`, `package.json`, and README
      consistently identify the Makeitfuture Sustainable Use License as source-available/fair-code
      rather than OSI open source; `THIRD_PARTY_NOTICES.md` and `public/fonts/OFL.txt` preserve
      Poppins' OFL terms.
- [x] `test/license.test.js` (v1.4 case, reconciled 2026-09-07): the license is stamped
      `Version 1.3` and names ChannelGate (formerly Claude Gateway for Slack) with the author line;
      §3.1 keeps the dedicated-deployment conditions, adds the customer's-key condition, and permits
      any number of separate deployments without an agreement; §3.2 defines license keys (no key →
      one conversation), end-user keys, no sharing/pooling, no reduction of an enterprise key's
      limits in term; §4.5 forbids circumventing verification, limits, or reporting; §4 names the
      Reseller, White-Label, Enterprise, and optional Partner agreements; §5 defers to
      `TRADEMARK.md`, which states nominative use and the no-own-product-name rule; §6 points at
      `CLA.md` 1.1 (relicensing grant, copyright stays, `Signed-off-by`, no automatic relicensing
      promised); `AUTHORS.md` records the author and the IP assignment and the decision record is
      a concise public rationale; §11 sets Romanian law and Bucharest venue. **Control:** no public text
      (license, CLA, FAQ, keys, README, CHANGELOG, checklist, trademark, authors) contains the
      operative Change Date wording — no "fourth anniversary", no delayed "additionally available
      under", no Change Date section, no Apache-2.0 grant in the license — and the FAQ, README, and
      CHANGELOG each state that no version is relicensed automatically. `docs/LICENSE-KEYS.md`
      carries the tier table (1/500, unlimited/500, unlimited/unlimited), end-user keys, the 14-day
      offline grace, and the no-content payload; the FAQ's one-liner, the twenty-clients example,
      and the agency-key-in-every-client counterexample are present; the FAQ declares itself
      subordinate to `LICENSE.md` and, with the decision record, keeps the sandbox and
      backup/restore out of any paid tier and states Slack/Teams/Google Chat are free.
- [x] Encrypted backup snapshots live SQLite with `VACUUM INTO`; disposable restore drill decrypts,
      extracts, and requires `PRAGMA quick_check=ok`.
- [x] Central console redaction covers Slack/OpenAI token shapes, bearer credentials, and secret
      query parameters before service-manager logs receive them.
- [x] Linux systemd packaging asserts a dedicated non-login identity and hardening boundaries, and
      the uninstaller mirrors it (system + user units, current + pre-rename names, never the runtime
      root, root required for the system unit); the launchd packaging assertions retired 2026-09-03
      (Linux only). → `test/operations-readiness.test.js`, `test/channelgate-rename.test.js`.
- [x] Unit (2026-09-03, Linux only): the entry point refuses every platform but Linux with one
      plain line — `src/platform-gate.js` is dependency-free and `src/start.js` dynamically imports
      it after the Node floor and before the server graph; `serviceProbes()` is systemd-only
      (`test/operations-readiness.test.js`, `test/update-runner.test.js`).
- [x] Release artifact generation emits CycloneDX SBOM, in-toto/SLSA-shaped provenance, and SHA-256
      checksums; tag workflow retains evidence as an immutable workflow artifact.
- [ ] Operator canaries: clean-machine install/uninstall on a current Linux (the macOS leg retired 2026-09-03 — Linux only), 24-hour Slack and
      engine canary, forced update failure/rollback, off-host restore with independently stored key.

### Phase E module boundaries
- [x] Browser modules parse without a build step and the existing navigation, reconciliation,
      Composio, model, schedules, update, and settings suites remain green through `public/app.js`.
- [x] `test/message-normalize.test.js` directly covers stop/pending/slash normalization, exact bot
      mention removal, subtype filtering, and trusted-bot fail-closed behavior. Canonical hydration
      and trigger dedupe remain behavior-tested; the obsolete internal source-name assertion is
      intentionally retired.
- [x] `test/store-patch.test.js` verifies partial channel and user updates preserve omitted fields;
      `test/harden.test.js` verifies atomic replacement retains 0600 permissions. The full 704-test
      suite, dependency-free static check, and secret scan pass after the Phase F rebase.

### Public website
- The marketing / early-access site and its regression (static contract, form behaviour,
  lead routing, production smoke) moved to the site's own repository and are verified
  there.

### README hero guards
`node --test test/readme.test.js` — the repository landing page is an external promise, so its
shape is asserted, not reviewed by eye.
- [x] Exactly one H1 (`# ChannelGate`), and the tagline the site's meta description repeats is
      present as its own bolded line.
- [x] The `formerly <pre-rename name>` attribution appears exactly once.
- [x] "open source" never appears except inside the exact `not OSI open-source` disclaimer.
- [x] The CTA carries the URL-encoded discovery-call `mailto:` and both UTM-tagged links
      (product page + `partners.html`), with exactly one campaign-tagged CTA block.
- [x] Every relative Markdown link (anchors stripped) resolves to a file that exists.
- [x] Badge URLs are absolute https, whitespace-free, every percent-escape complete; static
      shields.io badges match `label-message-hexcolour`; the CI badge names `.github/workflows/ci.yml`,
      which exists.
- [x] Every `github.com` URL uses the single repository constant, so the launch rename is one `sed`.
- [x] The licensing section keeps `500 AI messages per conversation per month`, "no version is
      relicensed automatically", the no-key tier row, the three lanes, and links to `LICENSE.md`,
      `docs/LICENSE-KEYS.md`, `docs/LICENSING-FAQ.md`, `TRADEMARK.md`, `CLA.md`.
- [x] Hero sections appear in the release-plan order, with `## Prerequisites` (the first
      operational section) below them.
- [x] Public README has no links to absent demo/social assets, names Beta support and Enterprise
      SDK scope, and links to the consolidated maintainer release/attestation procedure.

### Foundation (Slices 1–3)
- [ ] Boot creates `~/.channelgate/{config,channels,logs}`.
- [ ] `GET /api/health` → `{ ok:true, revision:<boot git sha>,
      update:<sanitized transaction|null>, claude.available:true }`.
- [x] `GET /api/health` with no session → `{ok, instanceId, slack:{status, connected}}` and nothing
      else: a watchdog can distinguish connected / connecting / disconnected / error, while the
      workspace name, bot id, and connect error string stay behind a session or the internal secret
      (`test/health-liveness.test.js`, `test/run-api.test.js`).
- [ ] Creating a channel meta provisions `channels/<slug>/.claude/settings.json`.
- [ ] Runner: first turn creates a session; a follow-up in the same thread resumes it
      (Claude remembers prior context).
- [x] Unit: runner resolves the author's token only as `composio-user` and independently resolves
      the agent's own `composio-agent` from channel → organization; clean mode removes both.
- [ ] Subagent completion is enforced by the Stop hook in every generated settings variant
      (default/clean/auto + admin clone): a headless Claude run that launches a background
      Agent/Task subagent and tries to end its turn is blocked, waits, and its final answer
      contains the subagent's result (verified live 2026-07-21 via `--settings` + a sleep
      subagent). The old injected instruction rule is gone from `run.js`.
- [ ] `run_agent_in_background`: in a read-mode channel, ask the bot to delegate a task to a
      background agent — a 🤖 started note with a *Check status* button appears, the button shows
      ephemeral runtime + recent activity while running, and on completion the thread gets the 🔔
      note plus the agent's sanitized/chunked final report directly, without a second model turn.
      A failed/incomplete agent still gets an interpreted continuation. Daemon restart mid-agent-job →
      thread gets the "interrupted by a gateway restart" continuation instead of silence.
- [ ] Runner injects the author's Composio token (verify Composio tools are reachable for a
      user who has a token; not for one who doesn't).

### Plain-language process outcomes

- [x] `test/process-outcome.test.js` covers success; general and unknown failures; rejected
      input/options; missing/non-executable commands; direct and shell-encoded interruption,
      forced stop, crash, and timeout outcomes; startup failures; ANSI/control stripping; and the
      invariant that numeric process values are not used as the user-facing explanation, and shared
      secret redaction before a captured diagnostic reaches a user.
- [x] Background-job completion notices distinguish confirmed success, confirmed failure, and
      restart-unknown outcomes; their continuation prompt carries the semantic outcome and output
      tail while structured events retain the raw value/signal. The injected tool/Slack guide also
      instructs agents to report the plain-language outcome rather than an exit status.
- [x] Claude, Codex, and OpenCode generic failures/cancellation; Claude structured provider errors;
      CLI health; Codex MCP discovery; Drive sync fallback; local voice subprocesses; and
      transactional update commands have focused regressions proving semantic messages while raw
      status stays structured and redacted diagnostic text explains the concrete cause. Whisper
      provisioning and nightly CLI probes share the same formatter and pass the static source contract.
- [ ] Live: approve one successful and one deliberately failing background shell job. The success
      note says **completed successfully**; the failure note explains the class of failure and the
      continuation diagnoses captured output. Neither Slack message asks the reader to interpret a
      numeric process value. Repeat one missing-command and one time-limit/interruption case.

### Slack gateway (Slice 4)
- [ ] DM the bot with no mention → it replies.
- [ ] Post in a channel without mentioning → no reply.
- [ ] Post in a channel mentioning `@bot` → it replies in the thread.
- [x] Unit: `test/slack-attachment-recovery.test.js` verifies exact canonical root/reply hydration;
      cross-envelope `message` + `app_mention` deduplication; direct/legacy/attachment/block file
      extraction; complete-descriptor preservation; incomplete `files.info` resolution with one
      bounded retry; an empty `app_mention` race; immediate preceding-file recovery without reaching
      past intervening text; canonical-read fallback; requester preservation for 🤖 triggers; no
      retry for ordinary message events; authorization before recovery API calls; multiple generic
      file types; and safe history/thread id/name/MIME/size projection without private Slack URLs.
- [x] Unit: inbound attachment sinks share one 500 MB cap and stream to disk — a Slack download
      declared over the cap is refused by name and size before any request is made; a body that
      overruns the cap mid-stream is cut off, its temp file removed and nothing left in the thread
      folder; a multi-chunk body arrives complete with no temp left behind; an HTML sign-in page is
      refused from its first chunk; the Chat/Teams sink accepts a Response, a stream or a Buffer
      under the same cap and names an oversize refusal; `writeStreamNoFollow` cancels the
      connection, keeps the destination untouched and refuses a declared Content-Length over the
      cap without touching the body (`test/managed-write-symlinks.test.js`, `test/api-boundaries.test.js`).
- [x] Unit: `slack_download_file` — `parseSlackFileId` accepts a bare id or a Slack file link and
      refuses paths/channel ids; `fetchChannelFile` refuses a file Slack does not report as shared in
      the current channel (`ENOTINCHANNEL`), an empty channel context, and a non-id; the download
      lands at `uploads/<thread>/<id>-<name>` with the bot token as Bearer and is reused on the
      second call without a fetch; an oversize descriptor is refused by size with nothing written;
      through the MCP server the tool exposes only `file_id`, stays pinned to the signed channel and
      leaks no URL; it is listed un-gated (`test/slack-download-file.test.js`,
      `test/gateway-mcp-authz.test.js`, `test/mcp-control-plane-approval.test.js`).
- [x] Unit: thread-root retry — hydration carries the ROOT's file into a later reply marked
      `carriedFrom:"root"` past intervening text while a mid-thread file behind text is still not
      reached, and leaves a reply alone when the root has no file; `filterCarriedRootFiles` keeps a
      missing root file that fits the cap, drops one already on disk and one declared over the cap,
      and always keeps files attached to the reply itself (`test/slack-attachment-recovery.test.js`,
      `test/slack-download-file.test.js`).
- [ ] Live: post a recording on a thread's first message, then reply `@bot try again` (no file) →
      the reply turn downloads the root's file (status line, `uploads/<thread>/` populated) and
      analyzes it; reply again → no second download (already on disk). In another thread say
      `@bot download F… yourself` with the id of a file shared earlier in the channel → the tool
      returns the local path and the agent reads it; with the id of a file from ANOTHER channel →
      `not shared in this channel`. Both engines (QA: ATT-02).
      The `run_start` event for that second reply reads `files: 0` (nothing was downloaded) with
      `carried: 1` beside it — the count is the filtered set the engine receives, never the raw
      event's attachment list.
- [ ] Live: attach a ~250 MB screen recording (MP4) with an `@bot` mention in a container channel →
      the assistant status reads `is downloading 1 attachment(s) (… MB)…` while it fetches, the file
      lands under `uploads/<thread>/` with its full size, the daemon's RSS does not grow by the file
      size (`systemctl --user status` memory line before/after), and the `video-understanding` skill
      analyzes it. Attach a >500 MB file → the reply says `<size> exceeds the 500 MB attachment
      limit` and `events.attachment_failed` carries the same reason. Both engines (QA: ATT-01).
- [ ] Live attachment smoke: upload XLSX, PDF, image, and multiple files with an `@bot` mention in
      both a root and a reply; edit a file message to add the mention; and confirm each turn receives
      the local path under the same thread folder exactly once. Then read the thread with
      `slack_thread_replies` and confirm file metadata is visible but private URLs are absent.
- [ ] Reply within that thread (no mention needed in a thread? — decide; default: mention still
      required outside DM) → behaves per spec.
- [ ] A non-allowed user mentioning the bot → no run happens.
- [ ] Bot does not respond to itself / other bots (no loop).
- [x] Unit: `app_context_changed` accepts only bounded, allowlisted entity metadata; keeps the
      latest snapshot per workspace/user with TTL and capacity limits; attributes the viewer only
      from validated `event.user` even when the envelope carries a bot installation authorization;
      rejects stale/malformed events; injects the provenance preamble only into that authorized
      user's ordinary DM; and omits it from channels, clean turns, and other users
      (`test/app-context.test.js`).
- [ ] Mention `@bot` in a channel it isn't in (Slack offers to invite) → accept → after it joins it
      replies to that pending mention in-thread. Adding the bot with no recent mention → stays quiet;
      a leave/re-join doesn't resurrect an old mention (window + existing-session guard).

### Voice prompts (optional local Whisper + Slack fallback)
- [x] Unit: audio MIME/extension detection, bounded process timeout/output, shell-free argv handling,
      scratch cleanup, deterministic multi-clip ordering, empty-output failure, and single-job local
      concurrency are covered by `test/whisper-transcribe.test.js`.
- [x] Unit: Slack transcript metadata refresh, authenticated bounded full-VTT reads, VTT parsing,
      Slack-host-only URL validation, complete-preview fallback, truncated-preview refusal,
      local-first per-clip fallback, ordering, and disabled-mode zero-download behavior are covered
      by `test/whisper-transcribe.test.js`.
- [x] Unit: an unmentioned channel voice clip stays inert; mentioned, 🤖-reaction, and DM voice
      messages follow existing trigger semantics; authorization precedes both paths; typed text +
      voice compose one prompt; raw audio is omitted; and no-transcript guidance exits before an
      engine run (`test/slack-voice-prompts.test.js`).
- [x] Unit: the backward-compatible setting and Admin UI/API wiring are covered by
      `test/whisper-settings.test.js`; installer flags/env/prompt/default behavior, platform/checksum
      selection, archive safety, persisted skip, and conditional updates are covered by
      `test/whisper-installer-choice.test.js` and `test/whisper-install.test.js`.
- [ ] Live: an unmentioned channel voice clip causes no download, transcription, or reply; the same
      clip runs after an `@mention` or 🤖 reaction, while a DM follows current no-mention behavior.
- [ ] Live: an unauthorized author cannot cause an audio download/transcription in a channel or DM.
- [ ] Live: English and Romanian clips transcribe accurately enough to execute the spoken request;
      typed text acts as instructions, and two clips appear in their original order.
- [ ] Privacy: with local mode enabled, observe only local `ffmpeg`/`whisper-cli`; with it disabled,
      observe Slack metadata/VTT reads but no raw-audio download. In both modes, neither raw audio nor
      an audio path reaches Claude/Codex.
- [ ] Failure: remove/override runtime/model/`ffmpeg`; local failures fall back to an already-generated
      Slack transcript. With no Slack transcript, guidance says **Generate transcript**, clears
      progress, and starts no voice-only run.
- [ ] Provisioning: fresh setup on Linux (the macOS leg retired 2026-09-03 — Linux only) verifies both choices. Yes installs/reuses pinned
      Whisper + model; no downloads neither and update skips them. Flags work noninteractively;
      `npm run whisper:install` repairs assets after enabling the Admin setting.

### Admin UI (Slice 5)
- [ ] Channels list shows seen conversations; editing allowedUsers/MCPs/skills persists.
- [ ] Open two channels with different memberships: each **Guest access — named users** picker
      lists only that channel's current human members, includes internal and external users by
      display name + Slack ID, and never shows unrelated users from the org-wide Users page.
- [ ] Select a current external member, save, and reload: the grant persists. Submit a stale,
      forged, bot, or deleted-member ID directly to the channel-meta API: it is not persisted.
- [ ] Disconnect Slack and open a channel: the guest picker shows an unavailable/preserved state.
      Saving another channel setting omits `allowedUsers` and keeps the existing grants unchanged;
      an explicit guest-list API write returns unavailable rather than accepting unvalidated IDs.
- [ ] Setting a user's Composio token + admin flag persists and affects the next run.
- [ ] Composio token shows masked after save (write-only).

### Channel access model (capability profiles + two-axis access)
- [ ] Channel General tab shows a **Capability profile** dropdown (Read-only/Worker/Autonomous/Full
      access/Lean/Custom) with help text; picking a preset hides the raw flag checkboxes; **Custom** reveals them.
- [ ] Saving a preset persists the right flags (Full → `adminMode`; Worker → `allowBash`; Autonomous →
      `allowBash+autoMode`; Lean → `cleanMode`) and re-provisions `.claude/settings.json` accordingly.
- [ ] A preset overrides a stale flag sent in the same save (preset is authoritative); Custom keeps the sent flags.
- [ ] A pre-existing channel (no stored `profile`) shows the correct preset derived from its flags.
- [ ] **Who can use** (Approved/Admins/Locked) is editable per channel and changes who may talk.
- [ ] Grant a current channel member explicit guest access, then remove that user from the Slack
      channel: `member_left_channel` removes only that ID from `allowedUsers`, keeps all other
      channel metadata intact, and re-opening the picker no longer shows the departed user.
- [ ] Race a guest-list save against that member leaving after roster validation but before the
      metadata commit: the per-channel mutation lock serializes both operations and the departed ID
      is absent after both complete.
- [ ] **Who can manage** = *Channel members*: an approved member can `/mode read|bash|auto` and toggle bash/auto
      via the control MCP, but `/mode admin`, network, and work-dir are still refused (org-admin-only).
- [ ] **Who can manage** = *Custom*: only a listed manager (or an admin) can change safe settings; others refused.
- [ ] Default `manageAccess:"admins"` is unchanged behavior — non-admins cannot manage until opted in.
- [ ] Network toggle is hidden in Read-only/Lean; visible for Worker/Autonomous/Full.
- [ ] Advanced disclosure holds memory/nudges/refuse-org-tokens/work-dir/engine/model/effort; all still save.
- [ ] Settings → **Reset all channels' access to default**: confirm dialog; resets use→org default + manage→admins,
      clears custom guest + manager lists on every channel, leaves capability/skills/tokens untouched; logs
      a `channels_access_reset` event.
- [x] Unit/integration: organization, channel, and authenticated-user skill/connector grants union
      live; a more-specific duplicate connector replaces its broader definition; Claude/Codex MCP
      selections stay independent; OpenCode MCP stays empty; invalid/traversing skill names are
      rejected; caller-supplied API principals receive no user grants; and concurrent users get
      isolated per-run settings/skill views. Stable warm-session fingerprints ignore only the
      capability nonce while retaining author/origin/trust/renewal scope, and Claude→Codex fallback
      remints an engine-bound capability (`test/access-grants.test.js`,
      `test/run-grant-isolation.test.js`, `test/run-engine-mcp.test.js`).
- [x] Admin UI/API: org/channel/user tier navigation round-trips authoritative grants, preserves
      saved-but-currently-unlisted skills, and cannot erase connector selections when discovery is
      still loading (`test/access-grants.test.js`).

### Observability (Slice 6)
- [ ] Slack shows a live progress card as the first thread message, then an uninterrupted final
      answer beneath it with a token/cost line; expanding “Thinking completed” does not split text.
- [ ] Live (SLK-204/SLK-202, both engines): a turn whose model writes a preamble sentence BEFORE its
      first tool call still shows the toolbox with every tool/subagent row (the card may sit under
      the answer when text came first); a `report_progress` plan shows each stage's details/output
      exactly once in the finished card. A plain text answer still arrives as a single message with
      no card.
- [ ] Live (SLK-206): force a rate-limited/failed `stopStream` on a long turn — the thread ends with
      the progress card plus exactly one complete answer message carrying the footer, with no
      truncated partial copy and no stats-only message.
- [ ] Live (SLK-207, both engines): while the workspace is being rate-limited on
      `assistant.threads.setStatus` (many concurrent turns), a finishing turn posts its answer
      within seconds of the engine's last token — the answer must not wait for the status surface —
      and the shimmering status is cleared once Slack answers again. Evidence: the answer's Slack
      timestamp against the run's `run_done`/usage row, and no lingering status line in the thread.
- [x] Unit (SLK-207): with `assistant.threads.setStatus` stuck (a request that never returns),
      finalize still posts the complete answer with its footer block and no classic fallback, only
      one status request is ever outstanding, and the terminal clear is still written once Slack
      answers; twenty-five rapid activity phases queued behind one stuck write collapse into a
      single later request carrying the LATEST phase, followed by the clear
      (`test/slack-progress.test.js`).
- [ ] Native Slack streaming: on a routine turn, the reply is written live
      (chat.startStream/appendStream), the footer appears as a block at stopStream, and no extra
      activity-log/Plan messages are posted; a run with progress has one separate first task-card
      message plus exactly one answer message (no duplicate final post), while a text-only turn has
      only the answer. Falls back to a plain answer if answer streaming errors.
- [x] Unit: tool/thinking chunks and Markdown use distinct native streams on one serialized queue;
      the card's first append precedes the answer's first append, neither payload type crosses into
      the other stream, and both terminal snapshots close without losing footer, requester mention,
      fallback, stop, or rollover behavior (`test/slack-progress.test.js`,
      `test/slack-requester-tag.test.js`).
- [ ] A small GFM pipe table written in the answer renders as a styled table in native
      `markdown_text` streaming (including inline code/bold cells); if streaming fails, the classic
      reply fallback preserves the same rows as an aligned monospace grid.
- [x] Unit: stream progress receives a tool event and uses native `chatStream` +
      `assistant.threads.setStatus` without calling `chat.postMessage`/`chat.update` for the custom
      activity log; `loading_messages` puts the resolved model in the prominent
      “Gathering information” indicator, later compact activity phases retain it, and a
      Claude→Codex runtime change replaces both labels
      (`test/slack-progress.test.js`).
- [x] Unit: the shared assistant-status boundary clips every `loading_messages` entry to Slack's
      50-character validation ceiling with an ellipsis, never splits a UTF-16 surrogate pair,
      caps the rotation at ten entries, and applies the same normalization to live thinking
      summaries (`test/slack-progress.test.js`).
- [x] Unit: reply footer controls have unique registered `action_id` values with the root Files
      button plus five direct-review buttons; native `invalid_blocks` finalization retries the same
      stream without footer blocks, re-sends the terminal toolbox, and does not duplicate terminal
      markdown already retained by the SDK; classic delivery preserves stats in a text-only trailer
      instead of failing the completed run (`test/review-file-buttons.test.js`,
      `test/slack-progress.test.js`, `test/util.test.js`).
- [x] Unit: a failed tool carries its failure in its own row title (`⚠️ … · failed`) and still closes
      `complete`, healthy sibling rows are untouched, and no chunk — transient or terminal — ever
      emits `status: "error"`, so Slack cannot repaint the card with a run-wide failure header
      (`test/slack-progress.test.js`).
- [x] Unit: review buttons resolve the folder-relative paths agents actually write
      (`docs/spec.md`, `./docs/spec one.md`, a `:line:col` suffix) against the run cwd, while the
      same confinement check still rejects `../outside.md`, an escaping symlink, a directory, and a
      missing name; a bare word with no separator or extension (`main`), a command-shaped span
      (`npm test`), and an `https://` URL stay prose even when a matching file exists
      (`test/review-file-buttons.test.js`).
- [x] Unit: the injected guide teaches the contract the matcher implements — `gateway-usage`
      SKILL.md carries the inline-code rule and the folder-relative form, `references/
      writing-replies.md` carries the ✅/❌ examples, the separator-or-extension requirement, and
      the no-Markdown-link rule, and `references/git-repos.md` points repo reports at the canonical
      checkout rather than the removed worktree copy (`test/review-file-buttons.test.js`).
- [x] Unit: native `task_update` timeline — a tool call emits a row that ends `complete`; an earlier
      tool completes when the next tool starts and the last completes when the answer text begins; a
      `TodoWrite` snapshot maps completed→complete / in_progress and re-uses stable row ids across
      snapshots; a task-chunk append failure disables the card without dropping the streamed answer
      or forcing the plain-post fallback (`test/slack-progress.test.js`).
- [x] Unit: a tool, failed tool or subagent event that arrives AFTER the first answer delta still
      opens the toolbox (its rows render, in a card message separate from the answer text), while a
      text-only turn that runs long enough to beat twice never opens a card just to show the
      liveness pulse (`test/slack-progress.test.js`).
- [x] Unit: a task row's rich fields are delivered once — exactly one chunk carries a stage's
      `details`/`output`, the status flip and the terminal seal omit an unchanged value, a grown
      output is sent as its added tail only, and the reconstructed card (title/status replaced,
      output appended) renders each stage output exactly once (`test/slack-progress.test.js`).
- [x] Unit: a rate-limited `chat.stopStream` deletes only the partial answer message, posts exactly
      one classic answer carrying the run-stats footer and its controls in the same message (never a
      stats-only trailer), and still seals the progress card
      (`test/slack-progress.test.js`).
- [x] Unit: a run beyond five minutes emits completed heartbeat pulses every 20 seconds and rotates
      task IDs before Slack's five-minute threshold; finish, stop, and failure paths relabel the
      newest pulse, abrupt restart leaves no open row, and no text recap is appended after the answer
      (`test/slack-progress.test.js`).
- [x] Unit: message-level native-stream rollover starts its age clock only after Slack creates the
      message; the progress card and answer keep independent age clocks, a long pre-answer card
      rolls repeatedly before five minutes and seeds each successor
      with the full completed/live toolbox; a long answer copies its exact compiled Markdown into
      the successor before deleting the retired bot message. Cleanup failure keeps both safe copies,
      successor-seed failure delivers the complete classic fallback, and final delivery closes only
      the newest healthy stream (`test/slack-progress.test.js`).
- [x] Unit (SLK-208): an ANSWER stream Slack ended first — `message_not_in_streaming_state` on a
      mid-answer append, and on the terminal stop that carries the footer — is republished into a
      fresh stream holding the whole compiled answer plus the refused delta; the footer lands on
      that surviving message, the stranded partial is deleted, and no duplicate answer is posted
      beneath it (`test/slack-progress.test.js`).
- [x] Unit: a progress card whose stream Slack ended first (`message_not_in_streaming_state` on an
      append, on the scheduled rollover, or on the terminal seal) is republished into a fresh stream
      carrying the complete toolbox — warning rows and rows that never reached the dead message
      included — and the stranded copy, which Slack renders as a bare "Something went wrong", is
      deleted only after the replacement is durable; the replacement is sealed with the finished
      toolbox, and a handled tool failure still produces no `error` row anywhere
      (`test/slack-progress.test.js`).
- [x] Unit: the shared strict `report_progress` schema accepts object/JSON snapshots and bounded
      rich fields, rejects duplicate IDs, invalid sources, oversized collections, and multiple
      active steps; Claude and Codex emit the same normalized event while suppressing the
      meta-tool's low-level row (`test/progress-report.test.js`, `test/codex-args.test.js`).
- [x] Integration: the live gateway MCP `tools/list` advertises the full discoverable contract and
      `callTool` accepts valid snapshots while rejecting semantic/schema violations; generated
      Claude settings and Codex registration expose it only for opted-in visible, non-clean turns,
      while clean/recovery/scheduled/headless contexts omit it and suppress stale valid-shaped
      events without dropping ordinary progress
      (`test/progress-report-mcp.test.js`, `test/folders-settings.test.js`,
      `test/codex-args.test.js`, `test/progress-report-availability.test.js`).
- [x] Unit: progress-report snapshots stream a `plan_update` title and stable rich `task_update` rows into
      the answer's one expandable toolbox beside ordinary tool history; no supplementary Plan
      message is posted. Identical snapshots deduplicate, authoritative revisions remove stale rich
      fields, chunk failures disable only the toolbox, interruption drains queued writes and seals
      only the active step as a terminal ⚠️-titled row (never `error`, which Slack would render as a
      card-wide "Something went wrong" header), final answer-delivery failure interrupts it exactly
      once, and terminal intake ignores late snapshots. A stage the agent itself declares `error`
      keeps that status, so the card can still report a genuinely failed run
      (`test/slack-progress.test.js`).
- [x] Unit: the injected `gateway-usage` guide instructs agents to use Plans only for substantive
      work with 3+ meaningful stages, materializes the reference into channel folders,
      documents lifecycle and failure rules, excludes routine turns, and validates the four-stage
      multi-agent subscription-validation snapshots against the shared schema
      (`test/progress-report-guide.test.js`, `test/folders-skills.test.js`).
- [x] Unit: the injected guide makes subagents mandatory for long analysis/research/review and
      processing 100+ independent items; requires bounded scopes, independent verification when
      warranted, and truthful role/model/effort/scope disclosure; refreshes exact batch, item, and
      disagreement counters at stage/subagent/batch checkpoints; and preserves the daemon handoff
      plus no-Plan behavior for unsupported contexts (`test/progress-report-guide.test.js`).
- [x] Unit: legacy saved `progressView` values resolve to `stream` in settings/API output
      (`test/store-patch.test.js`).
- [x] Unit: Claude Agent/legacy Task launches plus `task_started`, `task_progress`,
      `task_updated`, `task_notification`, and task-scoped `tool_progress` messages normalize to
      stable `agent_activity` events; Codex collaboration spawn/`agents_states` updates plus raw
      snake/camel-case `sub_agent_activity` payloads normalize to the same contract, alias
      spawn-call IDs to child-thread IDs, and do not treat spawn-tool completion as child
      completion (`test/progress-report.test.js`,
      `test/codex-args.test.js`).
- [x] Unit: a real multi-agent Codex turn (CLI 0.152.0, multi-agent v2) maps to one card row per
      child — the `collaboration` spawn call opens the row under its task name, the
      `SubAgentActivity` start and finish merge into it through the child's thread id, an encrypted
      spawn message never reaches a title, and the empty `wait` collab item renders the
      coordination step instead of nothing; the `agents_states` path still drives per-child
      spawn/update rows, and both the exec (`collab_tool_call`) and session (`CollabAgentToolCall`)
      spellings are recognized (`test/codex-args.test.js`, `test/slack-progress.test.js`).
- [x] Unit + stub e2e: two consecutive Codex `agent_message` items stream as separate paragraphs,
      deltas inside one streamed item stay glued, a segment that already ends a paragraph is not
      padded twice, mapping without a run state injects nothing, and the authoritative `-o` final
      message is unchanged (`test/codex-args.test.js`,
      `test/codex-message-to-reply-e2e.test.js`).
- [x] Unit + stub e2e (SLK-203): a Codex turn whose stdout is what `codex exec --json` really sends
      for two subagents — the spawn calls absent and one anonymous `wait` item with empty
      `receiver_thread_ids`/`agents_states` — still yields a named row per child: the runner reads
      the children's own rollouts, announces `sandbox_reviewer`/`connector_reviewer` live while the
      parent waits, closes each row with its elapsed time and token spend from the same accounting
      pass, keys both events on the child's thread id so it stays ONE row, keeps the `wait_agent`
      coordination row, and still bills the children by name
      (`test/codex-message-to-reply-e2e.test.js`, `test/slack-progress.test.js`).
- [ ] Live Codex: in a Codex channel, ask for work that spawns two subagents. Verify the card shows
      a named row per child (not just one `wait_agent` row) for the whole wait, that each row ends
      with its elapsed/token metrics, and that the answer's stage narration and final answer are
      separate paragraphs (no "…sentence.NextSentence" glue).
- [x] Unit: the native task card keeps two subagent rows `in_progress` concurrently, updates and
      completes them independently, formats available elapsed/token/tool metadata, shows
      failed/stopped warnings, terminalizes missing lifecycle events, drives the assistant shimmer
      with the active-agent count, and preserves answer streaming when task chunks fail
      (`test/slack-progress.test.js`).
- [ ] Live: run a substantive four-stage validation over 100+ items with a primary worker and an
      independent verifier. Verify the plan names each agent's role, actual model/effort (or honest
      inherited/not-exposed state), exact scope, and counters; low-level tools and subagents share
      the answer's one expandable toolbox; exactly one semantic stage is `in_progress`; progress
      refreshes as batches return; and the terminal snapshot shows all four stages complete.
      Confirm no supplementary Plan message appears, then send a routine turn and confirm it adds
      no semantic stages.
- [x] Unit: the persistent toolbox is independent of assistant-status availability — an assistant
      thread (setStatus accepted) retains terminal tool rows without a duplicate text recap in its finalized answer
      message while the temporary status carries thinking summaries/tool labels and clears on
      finalize/stop; an ordinary channel thread (setStatus refused) keeps the same live toolbox;
      quiet reports reach both durable heartbeat rows and the temporary status where supported
      (`test/slack-progress.test.js`).
- [x] Unit: successful finalize, controlled stop, and every retired rollover message seal
      terminal plan titles plus `task_update` snapshots into `chat.stopStream`; successor streams
      inherit completed history and resume ongoing rows as `in_progress`; explicit Claude and Codex
      tool-result events complete/fail their matching row immediately without exposing raw tool
      output, while mapped Codex `command_execution` rows follow the same path as Claude tool rows;
      a disabled card is not retried at close and cannot poison answer delivery
      (`test/slack-progress.test.js`).
- [x] Unit: every persistent Slack write restores the independent temporary assistant status —
      immediately after toolbox/report chunks, and on a bounded cadence
      during answer streaming; status API requests stay serialized and terminal clear is always
      last, including when earlier writes are still in flight (`test/slack-progress.test.js`).
- [x] Unit: Claude thinking blocks emit a bare event then throttled latest-line summaries
      (clipped, none for redacted thinking); Codex completed reasoning items carry their summary
      text (`test/thinking-summaries.test.js`).
- [ ] Live: in a real agent/assistant thread, the collapsible toolbox streams tool and `TodoWrite`
      rows in the same message as the answer and remains expandable from Slack history after the
      turn. While the run is active, the separate shimmering status shows thinking gists and tool
      labels, returning promptly after stream writes and at worst on the 20-second heartbeat; verify
      it disappears at finalize
      and stop without removing the toolbox. Repeat in a plain channel thread, where the status
      no-ops but the same toolbox persists without a broken/duplicate card.
- [ ] Live: ask Claude and Codex separately to launch three native subagents with staggered waits.
      In both channel and assistant threads, verify one collapsible task card shows three parallel
      🤖 rows while they run, each row finishes independently and remains visible, and elapsed/
      token/tool metadata appears only where the engine reports it — stop or fail one child and
      verify its row closes with a warning while the sibling rows continue. In an assistant
      thread, also verify the temporary shimmer reports the active-agent count and then clears.
- [ ] Live: the prominent pre-answer loading copy reads `<model> · Gathering information…` once the
      run resolves, keeping the model visible when the right edge truncates; the compact activity
      line beneath the composer keeps the same model on later thinking/tool phrases, and both change
      to the Codex model if the turn falls back from Claude.
- [ ] Errors surface a readable message in Slack and a full entry in `logs/`.

#### Channel policy audit + refused secret reveals (2026-09-06)
- [x] Unit: `policyDiff` reports only the allowlisted policy keys that actually changed, with
      before/after values; an unchanged key writes nothing, a token / per-channel environment value
      / any other non-policy field can never appear in the payload, list keys compare by sorted name
      (a reorder is not a change), and `skills` reports a COUNT while a same-size grant SWAP is
      still detected as a change (`test/channel-policy-audit.test.js`).
- [x] Unit: one `PUT /api/channels/:channelId/meta` that turns Allow-network on, switches the
      channel to Full access and repoints its working folder logs exactly ONE `channel_meta_changed`
      carrying those three keys with before/after, actor `admin-ui`, source `admin-ui` — and nothing
      for the keys the save round-tripped unchanged (`test/channel-policy-audit.test.js`).
- [x] Unit: a save that moves no policy key (a nudges toggle, a re-submitted form) writes no event,
      and a `PUT /channels/:id/env/:name` still writes only its own name-only `channel_env_set` —
      the value never reaches any audit row and the env change does not duplicate into
      `channel_meta_changed` (`test/channel-policy-audit.test.js`).
- [x] Unit: the MCP `set_channel_network` handler logs `channel_meta_changed` with the Slack author
      as both actor and author and source `mcp`; re-setting the same value logs nothing; the
      admin-mode and workdir twins are audited the same way (`test/channel-policy-audit.test.js`).
- [x] Unit: a typed `/mode bash` logs one row with the author who typed it (source
      `slack-command`) including the preset move, while a bare `/mode` (read-only) logs nothing
      (`test/mode-command-audit.test.js`).
- [x] Unit: a refused `POST /api/secrets/reveal` logs `secret_reveal_rejected` with the requested
      field NAME, scope and reason and never a value; unknown scope, a `__proto__` probe and an
      unknown user each log one; the recorded labels are clipped so a padded body cannot inflate the
      events table; a granted reveal still logs only `secret_revealed`, without the value; and all
      three outcomes (granted / wrong password / refused field) carry the `admin-ui` principal in
      both `actor` and `author` rather than an empty author, with the attempted password never
      logged (`test/secret-reveal.test.js`).
- [ ] Manual: flip *Allow network* and *Full access* for a channel in the admin UI, then open
      **Activity → Admin & security events** — the change is listed with the conversation, `admin-ui`
      and `allowNetwork: on → off`. Type `@bot /mode admin` in that channel and confirm a second row
      naming the Slack author. Probe `POST /api/secrets/reveal` with a bogus field and confirm a
      *Secret reveal refused (not revealable)* row carrying the field name and no value.

### Mention resolution (@Name → real tag)
- [x] Unit: `resolveMentions` / `createMentionStream` / directory build — 28 checks (single- &
      multi-word longest-match, unicode, email guard, `@here`/`@channel`, inline code, existing
      `<@ID>` passthrough, streaming holdback across delta boundaries with no dropped text,
      pagination, deleted/Slackbot exclusion, ambiguous-name drop, maxWords, cache hit).
- [x] Unit: when one member's handle collides with another member's first name, the ambiguous bare
      `@FirstName` remains literal while both full names and unrelated single-person names resolve.
- [ ] Live: agent replies with `@<a real teammate's display name>` → Slack renders a real blue,
      notifying `<@UID>` mention (works in native streaming progress mode).
- [ ] Live: agent writes an unknown name, an email, and `@here` in one reply → all stay literal text.
- [ ] Live: with the `users:read` scope missing, replies still post (mentions just stay as plain text)
      and the boot scope self-check flags `users:read`.

### Automation (background jobs)
- [x] Unit: the native-loop bridge recognizes only the harness's pacing tools
      (`ScheduleWakeup`/`CronCreate`/`CronDelete`, never `CronList` or an unrelated tool), clamps a
      dynamic delay to the harness's own [60, 3600] window, substitutes the autonomous-loop
      sentinels instead of replaying them as a prompt, and refuses to arm from a malformed or
      half-streamed call (`test/native-loop.test.js`).
- [x] Unit: a `ScheduleWakeup` block in the Claude stream surfaces as one `loop_wakeup` event and
      never as a generic tool row (`test/native-loop.test.js`).
- [x] Unit: arming stores one quiet, thread-bound, session-resuming row per thread; a re-arm
      replaces the pending tick rather than stacking; the tick budget carries across re-arms and
      finally refuses with a stated reason; a stop reports how many ticks it dropped; loops are
      scoped per thread and never disturb a user's own schedules (`test/native-loop.test.js`).
- [ ] Manual: a loop tick queues behind a live message in the same thread (per-thread FIFO), and a
      `stop` while a tick is queued aborts it before it spends a turn.
- [x] Unit: the injected guide routes looping work to the NATIVE tools and states the three things
      the model cannot infer — `CronList` is not bridged, loops are finite, and how a loop ends
      (`test/native-loop.test.js`).
- [x] Unit (ART-005 / CTO-04 regression): the guide names the harness's OWN backgrounding as a dead
      end. `SKILL.md`, `references/background-jobs.md` and `references/loops.md` all name
      `run_in_background: true` (plus `nohup`/`at`/`screen`/`tmux` and in-turn sleep loops), state
      that those processes are killed when the reply is posted and can never report back, list the
      only three durable mechanisms (`run_in_background`, `run_agent_in_background`,
      `create_schedule`/loops), and require the agent to say so plainly instead of promising a
      follow-up when the channel's mode allows none of them
      (`test/subagent-completion.test.js`, `test/native-loop.test.js`).
- [ ] Live Claude (ART-005 / AU-07 re-check after the hard rules moved into the managed block):
      a long job in a channel whose mode allows no daemon background tool. Pass when the reply names
      the gate and offers `run_agent_in_background`/`create_schedule`; fail on any “I’ll report back”
      that follows the harness's own background Bash — confirm with zero `bg_*` events for the turn.
- [ ] Live (Claude): in a read/worker channel, ask for something long ("run the full suite and tell
      me when it's done"). Pass when the reply either runs it inline or names the mode gate and
      offers `run_agent_in_background`/`create_schedule`; fail on any "I'll report back when it
      finishes" that follows a harness background shell.
- [ ] Live (Codex): the same prompt. Pass when it offers `create_schedule` (or a bounded inline run)
      instead of narrating a sleep-and-check loop it cannot finish.
- [x] Unit: shell background jobs are mode-gated (the 2026-08 update plan (internal repo) A1) — refused before any
      approval request in a non-auto/non-admin channel; fail closed ("no approval channel") even in
      auto mode when no approver is wired; a deny (with reason) or an approval-layer error refuses
      the job; the approval request carries the exact command, the author, and the never-auto-
      approved "agent" type. The durable request returns without spawning, survives process-local
      executor replacement, starts directly from a later click, atomically refuses replayed clicks,
      reuses one card for the same exact action, and reconciles interrupted click execution against
      `bg_jobs` on boot (failing closed without proof rather than risking a duplicate process).
      An admin author in Admin mode starts directly without the second card; Auto mode retains it,
      and non-admin authors cannot use Admin mode's bypass.
      → `bg-agent-jobs.test.js`, `durable-approvals.test.js`.
- [ ] **Retired 2026-09-03 (Linux + containers only):** the `(unsandboxed)` wording — the card reads `Background shell job (in this channel's container)`;
      the rest of the entry stands. Live: in an auto channel, `run_in_background` posts a "Background shell job (unsandboxed)"
      approval with the exact command; the agent ends its turn immediately; *Run it* starts the job
      even after a daemon restart, *Deny* refuses it, and the same button cannot start it twice.
      Auto mode does not skip the prompt and pending durable cards do not expire after four minutes.
- [ ] In an auto channel, the agent calls `run_in_background` for a long command and ends its turn;
      an admin's later click updates the card with the job id/status and does not require or resume
      the original engine turn merely to start the command. In Admin mode, an admin author's job
      starts immediately with no approval card.
- [x] Unit: safe restart waits for ongoing engine/background/API/update work, rechecks until idle,
      repeats its idle observation after the final visibility post to close the intake race,
      restarts only after a clear observation, cancels at the five-minute deadline, coalesces
      concurrent restart requests, and exposes waiting/cancelled state to the Admin UI.
      → `restart-coordinator.test.js`, `run-api.test.js`.
- [ ] When the job finishes, the thread shows a "🔔 … finished — continuing…" notice and then the
      agent's continuation, with prior context intact (same session resumed). → bg_start/bg_finish in `logs/`.
- [ ] A failing/non-zero-exit job still continues, with the output tail handed to the agent.
- [ ] A job exceeding its cap is killed and reported as timed out (shell default 60 min).
- [x] Unit: runtime caps — agent jobs default to the one-week ceiling, shell jobs to 60 minutes;
      explicit requests are honored but clamped to one week; nonsense falls back to the default.
      → `bg-agent-jobs.test.js` (`resolveJobCap`).
- [x] Unit: admin outranks auto (2026-08-08) — `adminUnattendedTier` grants the auto tier only for
      an admin author in an adminMode channel on a NON-escalated run; dangerouslySkip, non-admin
      author, untrusted principal, and non-admin channels all disqualify. → `run-escalation.test.js`.
- [x] Unit: permission approvals auto-allow for an admin author in an adminMode channel (no card),
      still post buttons for non-admin authors, and never auto-allow "agent"-type control-plane
      sign-offs. → `slack-approval-object.test.js`.
- [x] Unit (2026-08-25): optional Codex MCP policy never emits a config Codex will reject — an
      unselected server (the live `composio_global` shape, admin and non-admin) produces NO
      override at all, since `mcp_servers.<name>.enabled=false` would define a transport-less
      entry and fail the whole config load; `apps.<id>` and `mcp_servers.<name>` are bare unquoted
      keys because a `-c` dotted path takes quoted segments literally; a non-bare name is dropped
      when unselected and refused when selected. → `codex-args.test.js`.
- [x] Unit: every bridged Codex MCP server carries `startup_timeout_sec=120` (gateway control
      server 60) so cold bridge spawns aren't dropped at Codex's 10s default. → `codex-args.test.js`.
- [ ] Live: in an ADMIN channel, an admin launches `run_agent_in_background` — the agent run's
      `run_config` event shows `adminUnattended:true, codexWritable:true, codexAutoApprove:true`
      (never `dangerouslySkip:true`), the agent can write in the channel workdir, and its
      `composio-user` tools are present. A non-admin author's agent in the same channel stays
      read-floor.
- [ ] Live: *Check status* on a FINISHED job answers with the persisted log tail ("already
      finished"); while running it shows elapsed/cap (cap rendered in h/d for agents).
- [ ] **Interrupted-turn recovery (auto re-run):** start a long turn (e.g. "@bot count slowly to 30")
      and restart the daemon mid-run; on boot the thread shows "🔁 … interrupted by a gateway restart …
      picking it back up", then promptly resumes the temporary shimmer, persistent toolbox/tool events,
      heartbeat, and answer deltas on the same session instead of staying silent until the final answer.
      → `active_runs` row exists during the run, gone after; `run_recover*` events in `logs/`.
- [x] Unit: stale `api_jobs` rows with `running` status remain recoverable when read/listed, and
      `recoverApiRuns()` rehydrates a persisted job, increments the attempt counter, and starts the
      background driver without marking it `interrupted`.
- [ ] Live: start a Slack-channel `POST /api/runs`, verify the kickoff thread includes the full
      request text, the response uses the configured progress/streaming view, and a daemon restart
      mid-run posts the restart note then completes in the same thread.
- [ ] Live: start a headless `POST /api/runs` with a webhook, restart the daemon mid-run, and verify
      the job resumes silently, `/api/runs/:id` reaches `completed`, and the webhook fires once.
- [x] Unit: a settled run publishes the engine's own cost when there is one, otherwise the figure
      the usage ledger settled on for the same run — the canonical component rollup where a run
      reported components — flagged `costEstimated`; `null` survives only when nothing knows, and a
      known zero is not treated as unknown (`test/api-runs-cost.test.js`).
- [ ] Live: run a Codex job through `POST /api/runs` and confirm `GET /api/runs/:id`, the
      `api_run_done` event and the webhook all carry the same non-null `costUSD` with
      `costEstimated: true` — and that it matches the Audit view's cost for that run.
- [x] Unit: controlled shutdown tracks cold engine children (including Codex), sends SIGTERM to the
      detached process group, escalates to SIGKILL, and untracks the child when it exits.
- [x] Unit: restart recovery joins the shared per-thread FIFO with progress report enabled, forwards
      runtime/tool/delta events into native progress, finalizes that streamed reply, and retains the
      final-only fallback for clients without native streaming; a busy warm-session fingerprint
      mismatch drains its promise chain before replacement; graceful
      shutdown disconnects intake, drains accepted turns to a bounded deadline, preserves only
      interrupted recovery rows, sweeps warm/cold groups, and has a synchronous final kill fallback.
      An explicit stop racing thread-context preflight cannot recreate its cleared durable row or
      launch the runner (`test/app-context.test.js`, `test/runtime-lifecycle.test.js`, `test/process-registry.test.js`,
      `test/progress-report-availability.test.js`).
- [ ] Live: start a long Codex turn, trigger `/api/daemon/restart` or `/update` while it is still
      writing, and verify the old Codex process group is gone after shutdown while boot recovery posts
      the "interrupted by a gateway restart" note and continues the turn.
- [ ] A turn that **completes normally** leaves NO `active_runs` row, so a later restart does NOT
      re-run it (no duplicate answers). A restart with nothing in-flight recovers nothing.
- [ ] Messages that arrive right after a restart (once Slack reconnects) are treated as new turns,
      never swept up as "stale" by recovery (stale set is snapshotted before reconnect).

### Google Drive sync (scheduled, service account)
- [x] Pure helpers unit-tested (`test/drivesync.test.js`): link→folder-id parsing (folders/ link,
      /u/N/ link, ?id= link, bare id, junk→null), bisync/test argv builders (auth flags, `--resync`
      only on first run, `--drive-impersonate` only with a subject), channel selection (carries meta
      so a custom workDir is honored), SA-JSON validation, and key materialization to a chmod-600
      file that's removed when the key is cleared.
- [x] Pasted service-account JSON: stored write-only (never returned to the client — only `hasKey`
      + `client_email` are exposed), validated as a real SA key on save (bad paste → 400), and the
      full pipeline reaches the Google Drive API when run with a real rclone binary (verified: a fake
      key produces a Drive auth error, not a spawn/ENOENT — confirming argv + service-account-file).
- [x] `testChannelSync` creates its working dir before spawning (spawn ENOENTs on a missing cwd, so
      the Test button must not depend on the boot-time sweep having run first).
- [x] Update provisions rclone (`scripts/update.sh` → `ensure_rclone`), verified across all branches
      with the real functions: Drive sync off → skip; on + rclone on PATH → present; on + rclone off
      PATH but a valid configured absolute path → present; on + missing → install (the official
      installer, best-effort, never aborts the update; the brew/macOS branch retired 2026-09-03 —
      Linux only); no settings file → skip.
      `read_setting` reads the right instance's `settings.json` (honors `CHANNELGATE_DIR`) via
      explicit-ESM node (stable under `"type":"module"`).
- [ ] Manual: on a host without rclone, enable Drive sync, run `/update` (or `npm run …` update),
      and confirm rclone gets installed and the Test button then connects. On Linux without
      passwordless sudo, confirm the update still completes and logs the manual-install hint.
- [x] Dormant by default: with the feature disabled / no key file / rclone missing, a sweep and the
      Test action no-op with a clear message and never throw (smoke-tested).
- [ ] Manual (needs rclone + a Workspace service-account key): set the global key-file path +
      enable; set a channel's Drive folder link; click **Test** → "Connected". Then wait one
      interval (or restart) → files appear in `<channel working folder>/Drive/`; a local edit there
      propagates up to Drive and a Drive edit propagates down, on the next tick.
- [ ] Confinement: the sync only ever writes under `Drive/` — `.claude/`, `CLAUDE.md`, `AGENTS.md`,
      `MEMORY.md`, `memory/`, `uploads/` are never pushed to Drive nor overwritten from it.
- [ ] A failed first run leaves no half-baked bisync state (the state dir is dropped, so the next
      tick retries with `--resync`).
- [x] Set the Drive folder link via the gateway MCP tools (`src/mcp/gateway-server.js`):
      `set_channel_drive_folder`/`clear_channel_drive_folder` are admin-gated (`requireAdmin`) and
      reuse the shared `parseDriveFolderId` (junk link → rejected before any write) + `testChannelSync`
      (the same read-only check as the UI Test button); `get_channel_drive_folder` is read-only.
      Syntax/import check green; full suite unchanged (189 pass).
- [ ] Manual: in a channel DM, ask the agent (as an admin) to "sync this channel with <Drive folder
      URL>" → `set_channel_drive_folder` saves the link, echoes the folder id + the SA `client_email`
      to share with, runs the connection test, and reports the global armed/not-armed state;
      "unlink drive" / "stop syncing" → `clear_channel_drive_folder`. A non-admin author is refused.

### Performance (clean mode)
- [ ] Enable "Clean mode" on a channel and send `hi`: `claude mcp list` inside the run shows NO
      servers (not even `gateway`), and the token footer drops to ~the base prompt (no MCP schemas /
      skills catalog vs. the same message with clean mode off).
- [ ] The channel's lockdown `settings.json` has `allowedMcpServers: []` and no `mcp__*` entries in
      `permissions.allow`; granted skills are NOT copied into the folder; no library skill-stub
      folders are present (pruned) and any legacy CLAUDE.md favorites block is stripped.
- [ ] With clean mode on, a non-admin's non-allowlisted tool is denied (no Slack approval buttons —
      there is no gateway MCP to host the prompt); Read/Glob/Grep (+ Bash if enabled) still work.
- [ ] Codex engine + clean mode: spawned argv contains no `-c mcp_servers.gateway.*` overrides.
- [ ] **`/clean` directive:** "@bot /clean hi" in a normal channel → footer shows ~27–28k input
      tokens (Claude Code baseline; ~30k+ without it); a follow-up reply in the SAME thread stays
      clean (no directive needed); other threads in the channel are unaffected; "/clean off" then a
      new message restores tools; "/clean" with no message posts the explainer without running;
      the clean turn's prompt carries no provenance line and no thread replay.

### Engines (Claude + Codex)

**Retired 2026-09-03 (Linux + containers only):** the entries below that exercise Codex's host
permission profiles, the semantic network compiler / `network_proxy`, the macOS seatbelt probes and
the credential/toolchain re-grants describe the retired host sandbox and are kept as history. Inside
its container Codex states `--sandbox read-only` / `danger-full-access` per mode; the container is on
the bridge network and *Allow network* is only a switch the engines are told about.

- [ ] Codex 0.147+ resume state: `CODEX_HOME` is stable and contains only linked auth/session
  state; private granted skills live under the disposable synthetic `HOME/.agents/skills`; cleanup
  removes those grants but preserves the stable home; the new `failed to resolve rollout path …
  file does not exist` response heals once with transcript replay while unrelated missing files do
  not reset a session.
- [ ] Engine precedence: global default `claude`, one channel set to `codex` → a no-directive message
      there uses Codex; `@bot claude …` in a thread flips that thread to Claude and sticks; other
      channels still use the global default.
- [ ] Per-thread directive parses punctuation variants ("codex:", "codex -", "codex build X").
- [x] Unit: existing threads stick to the engine that minted their session when the channel/global
      harness changes (no forced fresh session); an explicit per-thread/per-run ask still switches;
      new/unlabeled/matching sessions never trigger a switch (`test/session-engine.test.js`,
      `decideThreadEngine`).
- [x] E2E: a thread that started on Claude keeps the relayed Claude login when its channel's
      harness later moves to Codex ("continuing on claude"): the stub `claude` echoes `oauth=yes`
      on the resumed turn. The credential is resolved for the harness that actually runs, AFTER
      `decideThreadEngine`; before the fix the turn spawned Claude with no `CLAUDE_CODE_OAUTH_TOKEN`
      and a container answered Claude Code's own "Not logged in · Please run /login" (live,
      2026-09-03, a Codex-default channel on a production gateway). The test fails on the old ordering
      (`test/message-to-reply-e2e.test.js`).
- [x] Integration: a NEW thread whose first turn fails closed before the engine starts (the Claude
      relay gate, or the backend's credential gate) leaves NO session row — the row minted for it is
      deleted, not tombstoned; the same thread's next message runs on the channel's current harness
      (channel moved to Codex → the turn runs on Codex, session engine `codex`, one spawn); an
      EXISTING thread's session id and engine survive an identical pre-spawn failure. Both new cases
      fail on the old code (`test/runtime-integration-run.test.js`).
- [ ] Live (both engines, testing gateway or a Claude-less fixture): with the Claude login absent,
      a first message in a fresh thread of a Claude-default channel fails with the login remedy;
      switch the channel to Codex, reply in the SAME thread → Codex answers (no "this thread
      started on claude" line in the log). Mirror: Codex signed out, Codex-default channel, then
      switch to Claude.
- [ ] Live: start a thread in a Codex channel, flip the channel to Claude → the thread's next
      message still runs Codex and keeps its conversation; a brand-new thread runs Claude;
      `@bot claude …` in the old thread switches it (fresh session + thread-context replay).
- [x] Unit: gateway default model — unset → "" (CLI default) for both engines; per-engine values
      round-trip through saveSettings + settingsForApi; values are trimmed, non-strings ignored,
      blank clears; the admin-route `isValidModel` guard accepts known ids and rejects garbage.
- [x] Unit: an explicit pre-output/pre-tool model rejection (Codex `invalid_request_error`, Claude `model_not_found` — under a NEW session id, which the stub enforces) retries once with a distinct
      gateway default, updates runtime/model reporting, and labels the reply. Generic failures and
      post-tool model errors never replay; if the default also fails, the original error is kept.
- [x] E2E: the substituted model is visible in the thread the READER sees. Through the real Slack
      pipeline with a streaming stub (`CLAUDE_STUB_STREAM_TEXT` / `CODEX_STUB_STREAM_TEXT`), a
      rejected channel model on either engine delivers the ⚠️ substitution note at the head of the
      streamed answer — exactly once, with the answer intact and no `run_error`. Fails on the old
      code, which prepended the note to `result.content` that a natively streamed turn never posts
      (`test/invalid-model-handling.test.js`, live QA EN-03).
- [x] Unit: the orchestrator announces the substitution to the delivery layer (`answer_note`) on
      BOTH retry paths — the channel's own harness and a cross-engine fallback whose own model is
      refused — and still carries it on `content` for surfaces that render the finished reply
      (`test/model-default-fallback.test.js`).
- [x] Unit: the note streams as the head of the answer without claiming the turn started writing
      (a later liveness pulse still opens the task card); a tool-only turn whose text never streamed
      still delivers its whole answer under the note, with no duplicate; a note that arrives after
      the answer began becomes a durable card row (`test/slack-progress.test.js`).
- [x] Unit: a Codex refusal carried as the provider's RAW JSON body (`turn.failed` whose message is
      the whole `{"type":"error","status":400,…}` document) is unwrapped and classified as
      `model_rejected`, so it takes the same gateway-default fallback instead of dead-ending
      (`test/engine-failover.test.js`, `test/invalid-model-handling.test.js`).
- [x] Unit: `plainFailureText` turns a provider JSON body — bare, quoted inside prose, or wrapped in
      another body — into the sentence it carries, and never lets braces reach a thread
      (`test/process-outcome.test.js`); the Slack error card renders that sentence and, for a model
      rejection, names the model and the remedy (`/model` or the admin UI)
      (`test/invalid-model-handling.test.js`).
- [ ] Live: with no channel model set and a gateway default of `sonnet`, a run's `--model` is
      `sonnet` even after the admin's terminal `/model` picks a different model; a channel/thread
      `/model` override still wins; Codex-fallback turns use the Codex default, not the Claude one.
- [x] Unit: the `/model` wizard's model and effort steps emit buttons only (no `static_select`, no
      section accessory) — one button per curated option, unique indexed `action_id`s that the
      registered picker patterns match, ≤25 elements per actions block, wizard scope/thread/value
      encoded in every button value, exactly one button marked ✓ + primary (the "Gateway/Engine
      default" entry when nothing is overridden), and the patterns still match the retired bare
      `cg_model_pick` / `cg_effort_pick` select ids.
- [x] Unit: the model and effort steps each carry exactly ONE back button, pointing at the step
      before them (`cg_mw_back_engine` / `cg_mw_back_model`) and carrying that step's own
      scope + thread, so a mis-click is corrected without re-running `/model`; the back ids do not
      collide with the harness-step registration `/^cg_mw_engine_(?!reset$)…/` (a "← Back" click
      handled as a harness pick would silently rewrite the engine)
      (`test/model-wizard-buttons.test.js`).
- [ ] Live: run `@bot /model` in a thread, pick *Just this thread*, then pick the WRONG harness.
      Press **← Back** twice (to the harness step, then to the scope step) and confirm the same
      message repaints each earlier step in place — no new message, the scope step still offers
      *Just this thread*, and the harness step's `Current:` line shows the harness the mis-click
      actually stored. Finish the wizard on the right harness and confirm the done card's
      **Change again** reopens step 1 in that same message. Repeat with a channel-scope pick
      (admin author) and confirm walking back never widens or narrows the scope on its own.
- [x] Airtable: active dual-engine live definition `UI-MODEL-BACK-01` exercises the same-message
      Back/Change-again flow in both the Claude and Codex Auto fixtures.
- [x] Unit: admin-UI model dropdowns (Settings defaults, channel Runtime card, channel/DM config
      editors) list the wizard's curated options for the selected/inherited engine; a saved
      non-curated same-engine id shows as an extra option and stays selected; switching the engine
      swaps the list and drops the other engine's pick to blank. Fable 5 (`claude-fable-5`) appears
      only in the Claude list and never in GPT/Codex choices.
- [x] Unit/integration: Settings' confirmed channel-runtime reset is admin-authenticated, clears
      only `engine` + `model` for every channel (including a never-configured channel), skips DMs,
      preserves effort/access/skills/credentials, refreshes the conversation cache, and reports
      the affected count (`test/channel-runtime-reset.test.js`).
- [x] Integration (`test/transient-retry.test.js`): with failover ON, a transient failure that outlives
      every in-place retry is answered by the other harness (note "retried 2× before giving up —
      using Claude", `fellBack`, `fallbackFrom`) and the channel's next turn skips the primary for the
      outage cooldown; with failover OFF the retried error surfaces; `fallbackPolicy: "ask"` (a
      watched Slack thread, Settings → engineFallbackMode) hands the failure back with
      `details.askFallback { to, kind }` and writes NO cooldown (a following turn still runs on the
      primary), for an exhausted transient failure and for a limit-as-answer alike; when BOTH
      harnesses fail the message names both ("— Claude could not answer either: …") and a watched
      thread gets `askFallback.bothFailed`, an unattended origin does not.
- [x] Unit + integration (`test/engine-switch-choice.test.js`): the harness-switch card — store
      isolation from the busy-thread card (shared table, separate kind), owner-only / single-shot /
      expired clicks, the ask-mode failure posts the card with *Switch* / *Try again* buttons,
      *Switch* re-runs the original message on the other harness, pins the thread there and deletes
      the card, *Try again* re-runs where it failed and a second failure asks again; 🛑 discards a
      pending card with its own wording; auto mode never posts a card.
- [ ] Cross-engine failover, both directions: with failover ON, a usage-limit response or pre-tool
      authentication failure answers via the OTHER harness with a reason note and observes its
      per-engine per-channel / gateway-wide ~15-min cooldown; with failover OFF, the engine's own
      error surfaces. A post-tool failure never replays.
- [x] Unit: the Codex runner classifies its plan-limit rejection ("purchase more credits…") as a
      replay-safe `usage_limit` — as a JSON error event AND on stderr with a nonzero exit — while
      model rejections keep routing to the same-engine model retry, server/connection errors
      classify as `transient` (retried in place) and unexplained failures stay unclassified
      (`test/engine-failover.test.js`).
- [x] Unit + integration (`test/transient-retry.test.js`): a transient provider failure — the
      2026-09-03 Codex "404 Not Found: Unknown error", a 503, a 529, a connection reset — is retried
      in place on the SAME engine (two more attempts, env-tunable pause): the stub that fails its
      first two invocations still yields the reply, prefixed with the retried-N× notice, and exactly
      two `run_transient_retry` events; a failure that outlives every attempt surfaces the
      provider's own message marked "retried 2×" with NO cross-engine failover; a transient failure
      AFTER a tool ran (Codex) or after text already streamed (Claude) is never retried
      (replaySafe=false, zero retry events); the Claude `availability` kind ("API Error: 529
      Overloaded") takes the same path, and a retried FRESH Claude session runs under a new
      session id (the stub, like the CLI, refuses to create the same `--session-id` twice — three
      attempts, three ids, the thread keeps the one that answered); the warm Claude process's
      is_error result after a provider failure REJECTS replay-safe (unit, PersistentClaudeSession);
      authentication, usage-limit, model-rejection, invalid-request and the catch-all `provider`
      kinds are never treated as transient; the Codex classifier: a 404 naming the model is
      `model_rejected`, the CLI's underscore codes (`internal_server_error`, …) are `transient`, a
      "Reconnecting… (unexpected status 429 …)" progress line is transient (never a limit), and
      from stderr (`source: "stderr"`) only the explicit limit/auth phrasings count; the knobs are
      read per turn (clamped, duration syntax, unparseable → default).
- [x] Integration: a channel whose PRIMARY harness is Codex hits its usage limit and the turn is
      answered by Claude (reason note, thread transcript replayed into the fresh session,
      `fellBack`/`fallbackFrom` set); the same limit on stderr behaves identically; a limit that
      lands after a tool ran is NOT replayed; failover OFF and a disabled target harness both leave
      the error surfaced (`test/codex-failover-e2e.test.js`).
- [x] Unit: the Claude login resolver picks the OPERATOR's own `~/.claude` login ahead of anything
      in the gateway's engine home, falls through to the engine-home login only when the operator's
      session has HARD-expired, treats an expired ACCESS token as still usable (refreshing it is the
      relay's job), skips unparseable/tokenless files and names them in the remedy, honours the
      precedence setup-token → operator → gateway → API key → none, and exposes NO token material —
      only paths, expiries and an opaque fingerprint that changes exactly when the credential does
      (`test/claude-login.test.js`).
- [x] Unit: the relay reads and refreshes THAT source — a fresh operator token is handed out as-is
      even with an engine-home copy present, a near-expiry token triggers ONE serialized refresh run
      in the OPERATOR's own config dir (scratch cwd under the gateway root), no login anywhere
      reports the reason with all three remedies, and the warm-pool fingerprint keys on the source
      file + expiry (and a rotated setup-token) but never on the token text
      (`test/claude-token-relay.test.js`).
- [x] Unit: a HOST `buildClaudeEnv` carries the relayed token in the gateway-owned last group, so a
      channel secret named `CLAUDE_CODE_OAUTH_TOKEN` cannot displace it and no token at all still
      leaves the variable unset (`test/engine-runtime-isolated.test.js`).
- [x] Unit: `stableClaudeState()` links `projects`/`sessions`/`session-env`/`tasks` and NEVER
      `.credentials.json` — the link Claude Code's rename-on-refresh turned into a stale independent
      copy (`test/run-grant-isolation.test.js`).
- [x] Integration: a HOST Claude turn whose engine home holds a hard-expired credentials file and
      whose operator login is valid spawns with the OPERATOR's access token in
      `CLAUDE_CODE_OAUTH_TOKEN`, while still running under the gateway's own synthetic config dir
      (`test/runtime-integration-run.test.js`).
- [x] Unit: the Claude engine's `credentialState()` reports `authenticated` from the resolved login
      and changes fingerprint only when the credential does; `/status` names the login source, the
      config dir and the session expiry date, and flags an expiring or missing login with a warning
      marker (`test/claude-login.test.js`).
- [x] Unit: the hourly login watch DMs every admin ONCE per UTC day per message class — the same
      class on the same day is silent, the next day notifies again, a class change (expiring →
      missing) is news the same day, and a healthy login sends nothing and clears the class so a
      later expiry notifies afresh; an expiring login's DM names the kind, the config dir, the UTC
      expiry and the remedy and carries no token material or fingerprint, a missing login's DM
      carries the resolver's own remedy list; one admin whose DM fails does not stop the others (and
      does not re-spam the ones who heard it), a tick that reached nobody stays due, a throwing
      resolver is logged not thrown, the marker survives a simulated restart via `_meta`, admins come
      from the user store, and the first pass is deferred (not run at boot) and cancelled by `stop()`
      (`test/claude-login-alert.test.js`).
- [x] Unit: the Codex credential probe reads `auth.json` from the engine home first and the host
      state dir second, treats a `codex logout`-shaped file and an empty `tokens` object as signed
      OUT, treats an expired-but-refreshable access token as signed IN, and fails OPEN (`known:
      false`) on unreadable/unparseable/unfamiliar contents (`test/codex-auth.test.js`).
- [x] Unit: a signed-out host never spawns a Codex turn — it throws a replay-safe `authentication`
      failure with zero tool use; a sign-in line on stderr mid-flight ends the turn in seconds
      (well inside the inactivity window) and emits an `engine_note`; the SAME line after a tool
      ran neither ends it early nor makes it replayable; a process printing 401 retries forever
      still exhausts its silence budget and its wedge is classified as `authentication`
      (`test/codex-auth.test.js`).
- [x] Unit: every runner (cold Claude, warm Claude, Codex, OpenCode) records stderr as LIVENESS
      and never as progress; a liveness signal is remembered but does not reset the silence budget,
      so a chatty wedged process still hits it and the give-up report says the engine was still
      talking (`test/watchdog.test.js`).
- [x] Unit: only Codex's own sign-in phrasing ends a LIVE turn (an MCP child's bare `401
      Unauthorized` does not), while the post-mortem classifier stays broad; diagnostics shown to
      the user are the meaningful line, capped at 200 chars, with JWTs/bearer tokens redacted
      (`test/codex-auth.test.js`).
- [x] Integration: a Codex sign-in lost mid-turn is answered by Claude with "Codex authentication
      failed … using Claude"; the following turn still skips Codex while the credential is
      unchanged, and goes straight back to Codex once `auth.json` is replaced
      (`test/codex-failover-e2e.test.js`); the heartbeat row and assistant status show the harness
      diagnostic instead of "starting" (`test/slack-progress.test.js`).
- [x] Integration: a thread pinned by hand (thread engine override, or a thread model override that
      belongs to the running engine) surfaces the harness's own limit/auth error instead of failing
      over, and the error carries `runtimePinned`/`pinnedEngine`/`pinnedModel`; a stale thread model
      belonging to the OTHER harness pins nothing and still fails over
      (`test/codex-failover-e2e.test.js`).
- [x] Integration: a usage limit that arrives as the ANSWER (exit 0, zero tokens) is re-answered by
      the other harness on an unpinned thread, and on a pinned one keeps the notice with a one-line
      "pinned to X — say `codex` to move it" above it (`test/claude-fallback-e2e.test.js`).
- [x] Unit: the switch hint names the pin (harness + model) for a pinned failure and drops the
      "unavailable right now" outage phrasing, while still offering the manual move
      (`test/engine-failover.test.js`).
- [x] Unit: replay safety is judged against the engine that actually ran the turn — an error
      carrying another engine's id never authorizes a replay — and the failover graph is
      bidirectional while the read-only engine remains a non-source (`test/engine-failover.test.js`,
      `test/engine-adapter-contract.test.js`).
- [ ] Per-harness on/off: turn Codex off in Settings → it disappears from the global/channel engine
      pickers and the Slack `/model` wizard; a channel still stored as `codex` runs on Claude (with
      a fresh session + transcript replay); turning the last harness off is refused; a save that
      leaves the gateway default pointing at a disabled engine is refused.
- [x] Unit/integration: engines default to enabled; a partial enable map only changes the engines it
      names and drops unknown ids; a map disabling everything fails open at read time and is refused
      by the Admin API; the gateway default resolves past a disabled harness; the failover toggle
      honors the pre-rename `codexFallback` key and reports both keys to the API; the admin UI
      renders the switches and saves both engine settings (`test/engine-failover.test.js`,
      `test/engine-enable-api.test.js`).
- [x] Unit: a structured Claude `rate_limit` assistant event followed by a nonzero process exit
      preserves the provider's reset message and typed replay-safety metadata for both cold and warm
      runners; any tool attempt disables replay; a real orchestrated authentication failure falls
      through to the other harness and labels the result. Normal assistant prose mentioning limits is not
      misclassified. (`test/claude-limit-errors.test.js`, `test/claude-fallback-e2e.test.js`).
- [ ] **Retired 2026-09-03 (Linux + containers only):** the approved-domain half; the read/write mirror stands. Codex sandbox mirrors mode: read-mode channel → Codex write is refused; bash/auto → write works;
      approved-domain requests reach listed public hosts and refuse unlisted/local/private hosts
      (including Claude→Codex fallback); admin foreground Full access is labeled unrestricted.
- [x] Unit/integration: the signed gateway MCP exposes the same bounded `workspace_list`,
      `workspace_read`, and `workspace_search` tools to Claude and Codex; each operates only within
      the effective channel workdir, refuses traversal/escaping symlinks and binary/oversize reads,
      and the reduced memory-review toolset exposes none of them
      (`test/workspace-read-tools.test.js`).
- [x] **Retired 2026-09-03 (Linux + containers only):** Unit: semantic network compiler maps off/approved/unrestricted intent identically for Claude
      and Codex, normalizes/deduplicates public DNS patterns, refuses empty/global/local/IP/URL-shaped
      lists, and keeps explicit admin bypass unrestricted. Slack/admin capability labels expose the
      same boundary (`test/network-domains.test.js`, `test/network-policy.test.js`, `test/modes.test.js`,
      admin shell assertions).
- [x] **Retired 2026-09-03 (Linux + containers only):** the permission-profile half; `--ignore-user-config` stands. Unit: non-Full Codex argv (fresh, resumed, clean, network-enabled) emits `--ignore-user-config`
      plus the Gateway-owned permission profile (`default_permissions` + `permissions.gateway-readonly`
      / `permissions.gateway-workspace` extending `:read-only` with `:root` denied), and NEVER emits
      `-s`, `sandbox_mode`, `sandbox_workspace_write.*`, or a filesystem grant on the gateway runtime
      root; full access keeps the bypass flag and no restricted profile; the child TMPDIR points at
      the private per-run scratch dir for sandboxed runs only.
- [x] **Retired 2026-09-03 (Linux + containers only):** Live (macOS seatbelt, codex-cli 0.144.1): `codex sandbox` probes — readonly profile reads the
      workspace but not `~/.channelgate`, home, or a sibling folder, and cannot write the
      workspace; workspace profile writes the workspace + its TMPDIR scratch only (`.git` write
      denied, sibling/gateway/home reads+writes denied; a sibling run's scratch dir under the gateway
      root is unreadable). Real restricted `codex exec` run: outside reads denied, workspace write
      succeeds, the embedded gateway MCP `list_schedules` tool works with zero filesystem grants, and
      the scratch dir is removed at completion. Documented carve-out: `:minimal` keeps shared `/tmp`
      read+write open regardless of denies (platform behavior — nothing sensitive is placed there).
- [x] **Retired 2026-09-03 (Linux + containers only):** Live (macOS, codex-cli 0.144.1): the production-shaped permission profile with
      `network_proxy` reached allowlisted `api.github.com` and blocked unlisted `example.org`; local/
      private guards and both dangerous listener/socket switches remained false. The runner also
      checks `codex features list` before the first approved-domain spawn and fails closed when the
      installed CLI cannot enforce the profile. Both harnesses narrowly re-grant classic and XDG
      Git config plus GitHub CLI state only when write-capable Bash/Auto + approved networking are
      both active.
- [x] Unit: Codex argv injects `mcp_servers.gateway.default_tools_approval_mode="approve"` whenever
      the embedded gateway MCP server is present, so schedules/reminders/background/channel-admin
      tools do not hit Codex approval cancellation.
- [x] Unit: Claude channel settings include explicit `mcp__gateway__*` tool approvals whenever clean
      mode is off, and include neither the gateway namespace nor tool approvals in clean mode.
- [x] Unit: both injected Composio MCPs are pre-approved by default: Claude settings include
      `mcp__composio-user` + `mcp__composio-agent` outside clean mode, each Claude MCP config entry sets
      `default_tools_approval_mode:"approve"`, and Codex argv mirrors both named approvals.
- [x] Unit: the lockdown's `allowedMcpServers` carries a `serverUrl` entry for every injected remote
      server (Composio personal URL, Toolbox, the channel's Make toolbox URL; the
      `*.composio.dev` pattern in SDK mode) beside the `serverName` entries, and still does so when the
      channel picks a global server — Claude Code matches remote servers by URL once any `serverUrl`
      entry exists, which silently blocked Composio in #int-sales (2026-09-04). Clean mode stays empty.
- [x] Unit: a resumed Codex run configures exactly the MCP servers a fresh one does — the
      `mcp_servers.*` overrides of `exec resume <id>` and of a fresh `exec` are set-equal, and
      `gateway`, both Composio identities and both toolboxes are present in the resumed argv
      (WB-10: a warm Codex turn saw only the `gateway` family and lost Workbench).
- [x] Unit: header-bearing remote MCP servers reach Codex over its native streamable-HTTP transport
      (`url` + `http_headers_helper`), never through the `mcp-remote` stdio bridge, and the
      generated per-run helper resolves its credential from the run's 0600 bundle — printing the
      header on stdout, carrying no secret in its own source, and exiting 2 once the bundle is gone.
- [x] Unit: Codex JSONL `item.started` / `item.completed` events for MCP tool calls, shell command
      executions, and agent messages map to Slack progress callbacks (`tool_use` events + text
      deltas), so streaming/status modes can render Codex tool activity.
- [ ] Resuming a missing session starts fresh instead of erroring.
- [x] Unit: session-heal primitives (`test/empty-result-recovery.test.js`) — `isEmptyResult`
      identifies the 0-token/no-content incident shape (any content or token, cache reads included,
      is NOT empty); `abortPooled` on a thread with no warm session is a harmless no-op;
      `buildHealedPrompt` puts the thread transcript first, the session-was-lost note second, the
      original turn text last, and returns null with no transcript (bare-prompt retry for
      non-Slack callers).
- [ ] Live **session heal keeps thread context:** in a threaded conversation, break the stored
      session (delete/corrupt it), then send a context-dependent follow-up ("check again") — the
      healed fresh session answers with the thread's context (transcript replay), not amnesiac.
- [x] Unit: Codex watchdog is activity-based, not a wall-clock runtime cap; touching the watchdog
      before the quiet interval expires prevents it from firing until a full silent interval elapses.
- [ ] Live **stall watchdog (inactivity, not runtime):** a turn streaming steadily for >10 min is NOT
      killed; a wedged turn (no stdout at all) dies after `COMMAND_TIMEOUT` of silence with
      "stalled — no output for X minutes" + the "send `continue`" hint.
- [ ] **Auto-recovery:** kill the warm `claude` child mid-turn → the thread posts "resuming
      automatically…" and finishes via ONE auto-resume; a second death in the same turn surfaces
      the error instead. Restart the daemon mid-turn twice → boot recovery replays (attempts 1→2);
      a third interruption gives up with "interrupted repeatedly — please resend".
- [ ] **Empty result = failure:** a run returning 0 tokens + no content posts the "empty result /
      session may be in a bad state" error (never "(no output)") and can trigger diagnosis.
- [x] Unit + E2E: **answerless turn** (`test/answerless-turn.test.js`) — a turn that ran tools and
      spent tokens but produced no text is delivered as a notice naming the CLI's own ending
      (`error_during_execution`) and the step count, never as "(empty response)"; `isAnswerlessResult`
      and `isEmptyResult` never claim the same result; the run's usage survives the rewrite.
- [ ] Live **answerless turn:** in a long thread, a turn the harness aborts mid-flight (exit 0 with
      an error `result` line) posts the "finished without a final message — N tool calls ran,
      ended with `…`" notice with its normal footer, the thread stays resumable (next message
      continues the SAME session), and a `run_answerless` row lands in the Audit feed.
- [ ] **Self-diagnosis:** with `errorDiagnosisChannel` set, a non-recovered run error opens a
      🩺 thread in that channel with error + context and a root-cause reply; a second error within
      30 min does NOT spawn another; a failure inside a diagnosis thread is never re-diagnosed;
      `errorDiagnosisChannel: ""` disables the feature.
- [ ] **Footer & resume UX:** reply footers read "«Model»: ⏱ … · tokens · cost · ctx%" with no
      resume command in the text; `/resume` posts the thread's terminal command in a code block
      (built with the THREAD's engine, so a Codex thread prints `codex exec resume`);
      the 💻 button on "🛑 Stopped." opens the command modal; plain "status" goes to Claude while
      `/status` returns the daemon report. If the CLI reports a runtime model for the last turn
      (Claude `modelUsage` / Codex `turn.completed`), that model wins over any stale channel/default
      model in the footer, `/context`, and usage ledger. If Claude reports multiple models in
      `modelUsage`, the answering model is selected by dominant output tokens rather than first map
      key, and a reported `contextWindow` for that selected model wins over id-pattern guessing.
- [ ] **Per-message footer accounting:** run one fresh and two resumed messages in the Claude and
      Codex Auto fixtures. Each footer must show only that message's root-turn tokens/cost; Codex's
      second and third footers must not grow cumulatively. Activity retains the same root component
      and adds any native subagent components without adding them to the reply footer. Automated:
      `test/runtime-integration-folders.test.js`, `test/codex-usage-accounting.test.js`, and
      `test/message-cost-visibility.test.js`.
- [ ] **`/resume <command or id>` adopts a local session, same channel only:** paste the 💻
      button's `cd "<channel folder>" && claude --resume <id>` back into the channel it came from →
      "🔁 This thread now continues Claude session …"; the next message continues that terminal
      conversation with no Slack-history replay. Repeat the SAME command in a different channel →
      refused ("A session can only be resumed in the channel that owns its folder"), naming the
      owning channel. Keep the id but swap the `cd` for this channel's folder → still refused (the
      transcript's recorded cwd decides, not the pasted path). A bare id and a backticked/smart-
      quoted paste work identically; an unknown id, a non-id argument, and an OpenCode session are
      each refused with their own message. Adopt an id already bound to another thread → refused;
      `/clear` that thread, then adopt → accepted. `/resume <id>` during a live run → "This thread
      is mid-run"; bare `/resume` still prints the terminal command.
- [ ] **Adoption finds a CONTAINERIZED session (regression, CMD-203):** in a live channel on both
      engines, run a turn, then bare `/resume` and paste the printed container command
      (`podman exec -it -w <cwd> cg-… claude --resume <id>` / `… codex exec resume <id>`) straight
      back as `/resume <command>` in the same channel → "🔁 This thread now continues …", a
      `session_adopted` row in `events`, and the next message continues that conversation. Before
      the fix this was always refused with "I can't find … on the gateway machine", because only
      the daemon's own state dirs were searched while the transcripts live in the channel's HOME
      volume — which rootless Podman leaves unreadable from the daemon (`<volume>/` is 0700 and
      owned by the mapped sub-uid), so the container itself has to be asked. Paste the same command
      in a DIFFERENT channel → still refused by the same-channel rule. Paste a `claude --resume`
      line into a Codex thread with an unknown id → the refusal says "Claude session", not "Codex
      session", and names where it looked. Automated: `test/session-adopt.test.js` (both stores,
      Claude + Codex, the foreign-channel refusal and the wording) and
      `test/container-state.test.js` (the generated `sh -c`, executed by a real /bin/sh).
- [ ] **Global footer-cost visibility:** on a legacy/missing setting and with Settings → Behavior →
      Slack replies → “Show exact/estimated cost…” checked, Claude and Codex Slack footers include
      `$x.xx`. Uncheck and Save: subsequent interactive and API-triggered Slack replies omit only
      the dollar segment while model, duration, token counts, context percentage, and footer buttons
      remain. Re-check and Save: cost returns without a daemon restart.
- [ ] With footer cost hidden, confirm the same run still records cost in Activity, Overview totals,
      conversation cost badges, the usage ledger, and HTTP run API results.
- [ ] `node --test test/message-cost-visibility.test.js`: default-on and false round-trip, boolean-only
      settings route, shared-footer visible/hidden behavior, preserved non-cost segments, and Admin
      UI checkbox load/save wiring all pass.

### Modes & approvals
- [ ] `/mode` (admin) cycles read/bash/auto/admin; non-admin `/mode` in a channel is refused.
- [ ] read-mode + non-admin: a non-allowlisted tool posts Approve once / for-thread / forever / Deny;
      each behaves correctly and "forever" persists to `meta.approvedTools`. No click in 4 min → deny.
- [ ] Only the author / an admin / an approved user can click an approval; others get an ephemeral no.
- [x] Unit (`test/folders-settings.test.js`, `test/run-grant-isolation.test.js`): a channel that does
      NOT grant the shell (read, clean, and an admin channel's shared file) names `Bash` in the
      lockdown's `permissions.ask` — in the generated object, in the shared on-disk file, and in the
      per-run content-addressed copy — while a bash/auto channel keeps `Bash` in `allow` and out of
      `ask`; flipping the grant moves the per-run copy to a different digest, and `Write`/`Edit`
      (including the narrow `MEMORY.md` grant) never appear in `deny`. Regression: expressing "no
      shell" by OMISSION alone was not enough — Claude Code answers a simple command whose argv head
      is on its built-in read-only list (`id`, `cat`, `head`, `strings`, …) before it consults
      `--permission-prompt-tool`, so a read-mode turn executed `id -un` with no card.
- [x] Unit (`test/folders-settings.test.js`, `test/run-grant-isolation.test.js`): the ADMIN-RUN
      variant of a channel whose stored flags carry no shell grant (`adminMode` alone — what the
      `full` profile sets) grants `Bash`/`Write`/`Edit`/`MultiEdit` and carries NO `permissions.ask`
      key at all, in the generated object, in `settings-admin.json`, and in the escalated per-run
      copy; it still omits `disableBypassPermissionsMode`, keeps memory off, the deny list and the
      Stop hook, and equals the same channel built WITH the shell apart from the bypass key. The
      SHARED file of that channel is unchanged (`ask: ["Bash"]`, no `Bash` in `allow`,
      `disableBypassPermissionsMode: "disable"`), and a non-admin channel is untouched. Regression
      (2026-09-07): the variant was a clone of the shared file with one key deleted, so it inherited
      `ask: ["Bash"]`; the escalated turn has no `--permission-prompt-tool`, so Claude Code denied a
      bare `pwd`, refused `kill -9 $PPID` ("Contains simple_expansion"), reported the shell "not
      actually granted" and fell back to read-only.
- [ ] LIVE: in a Claude read channel, `@bot run id -un` raises an approval card and does not execute.
- [ ] LIVE (both engines): in an admin-mode (Full access) channel whose "allow shell" toggle is OFF,
      an ADMIN author asks the bot to run `pwd` — the command executes and the output is posted, with
      no approval card and no "shell not granted" fallback. A NON-admin author in the SAME channel
      asking for the same command still gets an approval card.
- [x] Probe against the PINNED CLI (`containers/versions.json`, Claude Code 2.1.258) — repeat on
      every Claude bump, the way the Codex Landlock flag is re-checked: a headless turn in a folder
      whose settings merely OMIT `Bash` executed `id -un` with ZERO `--permission-prompt-tool`
      calls; the same turn with `"ask": ["Bash"]` routed the call to the permission-prompt tool
      (`tool_name: "Bash"`, the command in `input`) and the command never ran; with no prompt tool
      at all (clean mode's shape) the ask failed closed as a denial.
- [ ] **Retired 2026-09-03 (Linux + containers only):** the sandbox wording — escalation is the bypass flag inside the channel's container, and auto mode
      stays inside it too. admin-mode escalation needs BOTH: admin author + adminMode channel → sandbox off; a non-admin in
      an admin-mode channel still gets prompted. auto-mode auto-approves but stays sandboxed.
- [x] Unit (`test/mcp-control-plane-approval.test.js`, the 2026-08 update plan (internal repo) A3): control-plane MCP
      tools block on a human Approve click — deny (with reason) blocks the change and nothing
      persists; allow lets it through; an unreachable approval endpoint fails closed; token values
      never appear in the approval payload; read-only tools and memory writes in both default and
      custom project workdirs never hit the endpoint; unauthorized callers get the handler refusal
      with zero approval requests.
      Explicit update exception: `update_gateway` still prompts in Read/Worker, skips the extra card
      in Auto/Admin for an admin author on both engine capabilities, and remains admin-only.
      Schedule exception (2026-08-19): `create_schedule`/`delete_schedule` are classified OPEN in the
      drift tripwire — they must never reach the approval endpoint.
- [x] Unit/manual (2026-08-19): with a deliberately UNREACHABLE approval endpoint (the fail-closed
      case), `create_schedule` still creates the schedule and `delete_schedule` still deletes it,
      while `set_channel_bash` on the same server refuses with "not approved" — proving schedules are
      un-gated without loosening the rest of the control plane.
- [ ] Live: in an auto channel, ask the bot to enable bash / add an MCP — each posts an Approve/Deny
      card and blocks until clicked; deny leaves state unchanged; auto mode does not skip the card.
      Asking for a reminder or a recurring check in the SAME channel posts no card at all: the
      schedule is created immediately and the reply says what was scheduled and when it fires.
- [x] Unit (`test/run-escalation.test.js`, the 2026-08 update plan (internal repo) A2): escalation is derived from
      principal + origin — the exhaustive origin×privilege matrix confirms only `slack_foreground`
      with admin author + adminMode + trusted principal escalates; every daemon-triggered origin
      (schedule/background_agent/continuation/recovery/diagnosis) and `api_foreground` never does;
      unknown/missing origin fails closed and `runMessage` refuses to start; a source tripwire pins
      that every call site declares its origin inline.
- [x] Unit + stdio integration (`test/mcp-capability.test.js`, `test/gateway-mcp-authz.test.js`,
      the 2026-08 update plan (internal repo) A4): signed grants round-trip the complete author/channel/slug/thread/
      origin/engine/principal-trust identity; wrong-secret, tampered, expired, incomplete, and
      missing grants fail closed; an API-spoofed admin cannot browse host folders or invoke gateway
      tools; fallback remints for its actual engine; every call revalidates the grant; generated MCP
      config contains no legacy `CG_CHANNEL_ID` / `CG_SLUG` / `CG_AUTHOR_ID` / `CG_THREAD_KEY`
      authority fields.
- [x] Unit (`test/slack-approval-object.test.js`): an agent `request_approval` (approvalType `agent`)
      posts a card showing the FULL `details` text (not clipped to 60 chars) with `cg_approve` /
      `cg_deny` / `cg_approval_comment` buttons and honored custom labels; with Slack unreachable it
      returns `{allow:false}` cleanly. MCP `tools/list` exposes `request_approval` (required `details`).
- [ ] End-to-end: the agent calls `request_approval` → an Approve/Deny/Comment card appears in the
      thread; **Approve** lets the run continue, **Deny** and **Comment** (modal → feedback) return the
      decision to the agent, only author/admin/approved may decide, and no click within the timeout
      resolves as not-approved. Unlike a permission prompt, auto-mode does NOT auto-approve it.
- [x] Automated (`test/approvals-api.test.js`): the admin approvals API. `GET /api/approvals` and
      both POST routes need an admin session (401 without one) and the `X-CG-Request` CSRF header
      (403 without it, and the refused call leaves the request still pending); the list carries
      conversation/requester display names, the tool, a clipped preview, age and expiry, and never
      the volatile continuation or the durable action record. `POST /api/approvals/:id` with
      `approve`/`deny` resolves the waiting run and names the principal (`admin UI`); `scope:
      "thread"` stops the next identical request in that thread from posting a card at all and
      `scope: "forever"` persists to `meta.approvedTools`; an unknown id is 404, a second
      resolution 409, a malformed decision or scope 400. A durable `background_shell` approval
      executes its exact action once and refuses the replay. Every resolution writes
      `approval_resolved_by_admin` with the principal and decision and no value from the request.
- [x] Automated parity (`test/approvals-api.test.js`): the same fixture resolved through the API and
      through `handleApprovalClick` produces the same decision and the same outcome card, differing
      only in the decider — the guard on the shared applier both callers now go through.
- [x] Automated (`test/approvals-api.test.js`): busy-thread cards over the same surface — the
      `awaitingChoice` row is listed, `cancel` drops the waiting message durably (no click can
      resurrect it), an unknown id is 404 and a malformed choice 400; `steer` re-enters the message
      pipeline with the exact stored event and its stored options.
- [ ] Live: with a real approval card in a thread, resolve it from the admin UI's Overview
      "Pending approvals" panel instead of clicking in the chat client. Pass when the run continues
      (or is refused) immediately, the card in the thread is edited to say the **admin UI** decided,
      the Activity feed shows `approval_resolved_by_admin`, and a later click on the now-dead card
      reports it already handled.
- [x] Automated (`test/approval-links.test.js`): the LINK form of the same cards. The token is
      signed over id + action + scope + expiry, so editing `once`→`forever`, swapping the approval
      id, flipping `deny`→`approve`, appending a character, or signing with another secret all read
      as `bad-signature`; a stale token reads as `expired`; a URL is only built from an http(s)
      base and always lands on `/approve/<token>`.
- [x] Automated (`test/approval-links.test.js`): the links are delivered to the REQUESTER in an
      ephemeral (never a second shared-thread message, and the card itself carries no link), the
      offered set is exactly what that person could click — no *Approve forever* for a non-admin,
      and a `requiredTier: "admin"` card gets *Deny* and nothing else — and every link points at
      that approval's own id.
- [x] Automated (`test/approval-links.test.js`): `GET /approve/<token>` renders the tool, the
      clipped command preview, the requester, the expiry and the one action the link performs, and
      leaves the approval PENDING however many times it is fetched (link unfurlers and scanning
      proxies prefetch); the same link then still resolves on `POST`. A used link is 410 on both
      verbs, and deciding a card kills its sibling links too.
- [x] Automated (`test/approval-links.test.js`): authority is re-checked at Confirm time, not only
      at mint time — an *Approve forever* link minted for an admin is refused 403 after that person
      stops being an admin, the request stays pending, and the SAME link works again once the
      authority is restored (a refusal must not silently destroy a credential).
- [x] Automated parity (`test/approval-links.test.js`): the same fixture resolved by link and by
      `handleApprovalClick` produces the same decision and the same outcome card, differing only in
      the decider; the waiting agent reads `decided_by: "link"`. `scope: thread` stops the next
      identical prompt in that thread and `scope: forever` persists to `meta.approvedTools`. Each
      resolution writes `approval_resolved_by_link` with the ids and the decision and no value from
      the request.
- [x] Automated (`test/approval-links.test.js`): a busy-thread card answered by link — the three
      links go only to the person whose message is waiting, `GET` leaves the card up, `POST` of
      *Cancel* drops the waiting message durably and no click can resurrect it.
- [x] Automated (`test/approval-links.test.js`): invalid tokens get per-IP exponential backoff
      (429 + `Retry-After`, and a perfectly valid token is refused while the backoff holds, because
      the limiter is about the address); the `approvalLinks` setting's three values behave — `off`
      mints nothing at all, `auto` needs a public URL before adding links to a surface that already
      has buttons (selected Testing with AI recipients only) but builds them anyway where there are none, `always` falls back to this
      machine's own address.
- [x] Automated (`test/approval-links.test.js`, `test/web-security.test.js`): that backoff buckets
      the REAL client, not the loopback proxy hop every public caller shares. Two bad tokens
      forwarded from `203.0.113.5` put THAT address into 429 while `203.0.113.6` is still served —
      including a valid link, which is the regression that let six bad tokens from anywhere disable
      every approval link; `CF-Connecting-IP` outranks a client-supplied `X-Forwarded-For`; a
      non-loopback socket ignores both headers unless `CG_TRUST_PROXY` is set; a header that is not
      an address is ignored.
- [x] Automated (`test/approval-links.test.js`): a busy-thread link names its conversation by SLUG —
      the confirmation page's *Conversation* row shows the slug and never the raw channel id, and
      the `approval_resolved_by_link` row carries the same slug (the record itself has none; it is
      resolved from the channels index).
- [ ] Live: in a channel with a `publicUrl` configured and the requester selected under Testing with AI, trigger a permission card. Pass when the
      requester (and nobody else) sees an ephemeral with three links; opening one shows the
      confirmation page with the command preview and leaves the card in the thread PENDING; pressing
      Confirm resolves it, the card is edited to name the requester with "(approval link)", the
      Activity feed shows `approval_resolved_by_link`, and reloading the link says it was already
      used.

- [x] Automated: `test/approval-links.test.js` exercises empty, selected, unlisted and removed
      Testing with AI recipients for permission and busy-thread cards in `auto`, `always`, `off`;
      includes admins, checks no tokens are minted for excluded users, and resolves native buttons.
      `test/settings-save-version.test.js` covers API default, persistence, clearing, deduplication,
      invalid inputs and malformed stored settings. No-native-button surfaces retain link behavior.
- [ ] Live, Claude AND Codex: use two approved Slack test users in separate Worker fixtures,
      auto approval disabled, public URL set, fresh threads and no cached/forever tool approvals.
      In Settings → Connection → Testing with AI select only user A; save and reload, verify A
      remains a selected chip and B does not. As each user prompt: "Ask me to approve a test using
      request_approval with approve text Continue and deny text Stop; wait for my decision."
      Pass: both get native buttons, only A gets private browser links, and either control resolves
      the request. Next prompt "Run sleep 30 then say finished" and send "Also say hello" while
      it runs. Pass: both get Steer/Queue/Cancel, only A gets private links. Remove A and repeat
      on fresh cards: neither gets links. Repeat in `always`; an empty list still excludes everyone.
      Set `off` with A selected: no links. Repeat with an unlisted admin requesting an explicit
      approval: role alone must not enable links. Verify an unrelated Settings save preserves the
      list, and saved IDs remain visible/removable if directory loading fails. Restore fixture
      settings. Capture cards, private-message evidence, decisions and settings reload for both engines.

- [x] Browser regression (engine-independent UI): `test/ai-testing-picker-browser.test.js` uses
      the real admin UI/API and disposable users Alpha Tester (`UTESTALPHA`), Beta Tester
      (`UTESTBETA`), 40 Sample Users and a saved missing ID (`USAVEDMISSING`). Run with
      `CG_BROWSER_MODULE=/absolute/path/to/playwright/index.mjs node --test test/ai-testing-picker-browser.test.js`.
      Search Alpha case-insensitively, ArrowDown + Enter to select; search Beta's ID and click;
      selected users disappear from results and remain as removable chips. Save/reload preserves
      all selections; missing IDs can be removed and clearing all persists. Search alone stays
      clean; no-match and Escape work; 30-result cap, 240px scroll region and no horizontal
      overflow at 1440px/390px. Optional `CG_UI_SCREENSHOTS` writes evidence images.
      The existing Claude/Codex live link-delivery cases above still apply to the saved list.

### Sandbox boundaries (bash / network)
**Retired 2026-09-03 (Linux + containers only):** the host sandbox is gone. The boundary is the
channel's container (only the work folder mounted — `~/.ssh`, the gateway root and sibling folders do
not exist inside it; see *Container runtime → channel isolation inside the containers*). *Allow
network* is a per-channel switch the engines are told about — no domain filtering and, in this
release, no egress cut-off — so the network entry has no container equivalent yet. Kept as history.
- [ ] Bash channel: write inside the folder works; writing `~/.ssh`, `~/.aws`, the gateway root, or a
      sibling channel folder is denied; reading the home root / gateway root is denied.
- [ ] Network off by default; allow-network + allow-bash → `gh`/`git push` succeed, a non-allowlisted
      domain fails.
- [x] Unit (CTO-04 regression): `modeLabel` states the network switch in BOTH directions — a channel
      with it off renders `Read-only · network off`, not a bare `Read-only`, so "off" is no longer
      indistinguishable from "never configured"; `{ detail: true }` adds
      `(advisory — not enforced by the container yet)` for the off state only, and an engine that
      does not declare the `on` mode still reads `network unsupported`
      (`test/modes.test.js`).
- [x] Unit (CTO-04 regression): `/status` carries the channel's own switches — `formatCapabilityLine`
      and the full report render `*🎚️ Mode*: Bash · network off (advisory — …)` and flip to
      `network on` when the switch is set, including on the "nothing running" report
      (`test/runtime-integration-surfaces.test.js`).
- [x] Unit (CTO-04 regression): the ENGINE is told. The gateway-managed block at the top of every
      conversation's `CLAUDE.md` (read by Claude via `--append-system-prompt-file` and by Codex via
      the `AGENTS.md` symlink) names the mode and the network switch in both directions, says an
      off switch means "NOT meant to use the internet", and admits the switch is advisory so a
      request that still succeeds is not read as permission — clean mode included
      (`test/folders-generator-paths.test.js`).
- [x] Unit (retest 2026-09-06): the same managed block carries the **hard rules**, because one
      engine never opened the `gateway-usage` skill body — the block names both Composio identities
      and makes an unnamed request that either could serve a question rather than a tool call, says
      `COMPOSIO_MANAGE_CONNECTIONS` INITIATES connections for any action including `list`, and names
      the harness's own backgrounding as unable to report back with `run_in_background` /
      `run_agent_in_background` / `create_schedule` as the only durable follow-ups. Present in clean
      mode too, and the gateway-owned part of the block stays under 4 KB
      (`test/folders-generator-paths.test.js`).
- [x] Unit: the same rule names the FINITE repeat-check case out loud — "check every N minutes, K
      times" is `create_schedule` (or `run_agent_in_background` for a self-contained watcher) and
      never an in-turn sleep/poll loop, a `Monitor`-style wait, or a harness background task, even
      when the loop would finish inside the turn (`test/folders-generator-paths.test.js`).
- [x] Unit (CTO-04 regression): the policy module says out loud that nothing enforces the switch —
      `NETWORK_POLICY_ENFORCED` is `false`, `NETWORK_ADVISORY_NOTE` is the one shared phrase, and
      the retired "off runs the container with no network at all" header claim cannot come back
      (`test/network-policy.test.js`); every `run_config` event records `networkEnforced: false`
      beside `networkPolicy` (`test/runtime-integration-run.test.js`).
- [ ] Live (either engine): in a channel with *Allow network* OFF, ask "are you allowed to use the
      network here?". Pass when the answer names the switch as off and says it is advisory rather
      than reporting that nothing tells it either way; then turn the switch on and confirm the next
      turn says on. `/status` and `/mode` must agree with the answer.

### In-thread commands & stop
- [ ] `/context` shows tokens + % of the context window from the last turn.
- [x] Unit: a configured 1M model keeps its 1,000,000 window even though the CLI echoes the plain id
      back (`opus[1m]` → runtime `claude-opus-5`), including when the runtime reports the family's
      standard 200k for it — `/context` and every footer percentage were measured against a window
      five times too small (automated: `test/model-info.test.js`).
- [ ] `/model` opens the runtime wizard: scope buttons (*This channel* / *Just this thread* — the
      thread button only appears when a thread is known), then harness buttons (*Claude* / *Codex* /
      *Use defaults*), then one **button per model** filtered to the chosen harness, then one
      **button per effort level** — no dropdown anywhere in the flow, and the choice already in
      force is prefixed ✓ and styled primary; each step persists as clicked and repaints the same
      message; a pre-buttons `/model` message still in Slack history (its model/effort
      `static_select`) still applies the pick instead of erroring. Admins in channels,
      approved/admin users in DMs; Settings → Access & security can allow every authorized channel
      user instead, for both channel and thread scope, and every wizard click rechecks the policy;
      the typed `@bot /model` in-thread command is the entry point
      (no slash command is registered in the Slack app manifest).
- [ ] Reply footer model follows the configured cascade: with a thread override set the footer
      shows the thread's model; else a set channel/DM model; else the gateway default; only with
      nothing configured anywhere does it show the CLI-reported default. The context % and Codex
      cost estimate still track the model that actually answered.
- [ ] `/model` thread scope: overrides engine/model/effort ONLY for that thread (other threads and
      the channel keep theirs); the thread's next turn replays the Slack thread when the harness
      changed; *Use defaults* clears the thread overrides (falls back to channel); a channel-scope
      pick made inside a thread clears that thread's overrides so it takes effect there.
- [ ] `/effort` and `/engine` (typed or as slash commands) answer with a removal pointer to
      `/model`; an old pre-wizard `/engine` dropdown message answers with the same pointer instead
      of erroring.
- [ ] Runtime UI effort options follow the selected/inherited engine: Claude shows Claude effort
      choices, Codex shows Codex reasoning levels; Codex argv includes `model_reasoning_effort`.
- [x] Unit: `/help` includes the practical user workflows: `@agent`/🤖 engagement, per-thread stop,
      file browsing, Composio setup, the skill catalog, memory/rules, automatic gateway skills,
      reminders/schedules, durable background work, `/status`, and `/pending`; it distinguishes a
      thread's `stop`/🛑 from the top-level `/stop` sweep.
- [x] Unit (EN-11/W26 regression): `/help` says a channel thread is stopped with `@agent stop` (or
      🛑) and that a bare `stop` needs no mention only in a DM — the un-mentioned channel message
      never reaches the stop check — and the retired "type `stop` in that thread" phrasing cannot
      come back (`test/help-text.test.js`).
- [ ] `/clear` drops the session (next message is a cold start); `/help` shows the practical guide
      and lists all commands (including `/status`, `/stop`, and `/pending`).
- [ ] `/delete` (org-admin only) inside a thread removes the BOT's messages there (replies before the
      parent) and posts an ephemeral summary; without an Admin User Token, human messages stay and
      the summary explains how to enable full deletion (Settings → Slack credentials).
      A non-admin (approved) author gets "Only admins can use `/delete`." and NOTHING is deleted.
      Top-level `/delete` replies with guidance; on a mid-run thread it refuses until stopped.
      Another thread in the same channel is untouched (scope check).
- [ ] `/delete` with an Admin User Token (xoxp) set: human/other-app messages are deleted too (token
      override per call); if the workspace refuses (admin-delete pref off), they're counted as
      stayed with the "even with the admin user token" wording. Settings rejects a non-`xoxp-`
      value for the field (400); the token is write-only (masked on read) and never appears in any
      run/MCP config.
- [ ] `/pending` (alias `/followups`) and the bare words `pending` / `my followups` reply in-thread
      with the CALLER's own live AI-waiting list — same formatting as the DM digest (permalink
      bullets, waiting time, preview); with nothing pending it replies with a short friendly
      "nothing pending" note (never silence).
- [ ] The bare-word trigger is exact-match: "pending review my PR" (or any other sentence merely
      containing the word) is NOT intercepted — it runs as a normal prompt.
- [ ] Stop: a plain "stop" message and a 🛑 reaction each halt an in-flight run and post "🛑 Stopped.";
      `/stop` is rejected by Slack inside a thread (words/reactions are the in-thread path).
- [x] Unit (`test/stop-card-engine.test.js`): the "🛑 Stopped." card's 💻 resume button names the
      harness the STOPPED THREAD ran on, not the gateway default — a Claude session in a
      Codex-default gateway resumes as Claude and the inverse resumes as Codex, a per-thread
      harness override outranks the session it was pinned onto, and with neither a session nor an
      override the channel's own engine beats the gateway default. A session id is engine-specific,
      so the old global-default read printed a `codex exec resume` line for a Claude session.
- [ ] Stop is the end of the answer, on both engines: stop a run that is mid-answer and nothing more
      than "🛑 Stopped." arrives — no full reply beneath the card, no chunked fallback. Whatever
      text had already streamed stays put, ending in `🛑 _Stopped — partial answer._`.
- [x] Unit: with answer deltas queued but not yet accepted by Slack (rate-limit back-pressure), a
      stop creates NO answer message at all — the stop path's own chain drain must not flush the
      buffered reply — and a finalize arriving after the stop delivers nothing by either surface;
      partial text that did land is closed with the `Stopped — partial answer` marker and the answer
      stream closes exactly once (automated: `test/slack-progress.test.js`).
- [ ] Stopped-request replay: stopping request 1 in a thread does not create replay context; stopping
      request 2+ records only that stopped user request, then the next message in the same Slack
      thread consumes it once before the current message.
- [ ] Busy-thread choice: send a second message while a turn is actively generating → the message
      does not run yet; an owner-only card offers *Steer Conversation*, *Add to Queue*, and *Cancel
      Request*. Choose Steer and Queue in turn: the temporary card disappears after the valid click,
      leaving only the user's original follow-up visible, and the message executes exactly once.
      Restart the daemon before clicking: the card still works and is not auto-run by boot recovery.
- [ ] Redelivered message never raises a second card: while a long turn runs, kill the daemon so Slack
      redelivers the unacked message envelope. On boot, recovery replays that message and the
      redelivered copy is dropped silently — it does not raise a card for a message nobody
      re-sent, and the thread is answered exactly once (either recovery or the copy owns it, never
      both). A genuinely new message sent after the restart still gets its card.
- [ ] Steer Conversation: choose it during a warm Claude, cold Claude, and Codex turn. The active
      turn stops quietly without dumping half-finished output or a false error, the chosen message
      runs next, and an immediate daemon restart cannot replay the abandoned turn. A different
      author's selection queues instead of interrupting the active owner's work.
- [ ] Add to Queue: choose it while any engine runs → the active process is not interrupted and the
      selected message runs FIFO after it. `/next <task>` remains the direct no-click shortcut.
- [ ] Cancel Request: choose it while a turn runs → the paused message never runs, the card is
      replaced by a cancelled notice, and the active run continues.
- [ ] Mention-by-reaction: 🤖 on a new top-level message, existing-session thread, or sessionless
      reminder thread rooted by this gateway engages the bot as the reactor; the first reminder
      turn understands the root and preceding replies. 🤖 in another agent's thread remains ignored.
- [ ] Command-only thread: type `@bot /model` in a channel, complete the wizard, then post a plain
      message in that thread and react 🤖 → the bot picks it up (the thread has no session and a
      human root, but the bot's own wizard reply proves ownership).
- [x] Unit (`test/slack-thread-ownership.test.js`): an existing session takes the no-read reaction
      fast path; a sessionless thread is accepted when this bot authored the root OR any reply in
      it (the `/model`-command case); a thread with only other agents'/apps' posts, a missing
      channel/thread/bot id, and a failed thread read remain fail-closed; the ownership scan
      follows Slack pagination but stops at the bounded page budget. The first-turn replay includes
      the daemon-posted reminder root plus earlier replies in chronological order and excludes the
      reacted request from duplicated history.

### Channel file explorer
- [x] Unit (`test/file-explorer.test.js`): every contained name is listed and readable, including
      protected/internal names, dotfiles, `.env`, credentials, `.git`, `CLAUDE.md`, confinement
      settings, and every skill directory. `..` and symlinks escaping the channel root are refused;
      escaping/broken links remain visible without open controls, contained symlinks work, text and
      binary previews are distinguished, modal state/actions are built, and the manifest registers
      `/files` plus the message shortcut.
- [x] Unit (`test/file-explorer.test.js`): the authoritative
      stored channel name reaches the modal title with Slack-safe ASCII and Unicode truncation; the
      subtitle shows the full absolute root/nested directory and refreshes on navigation, while
      modal metadata remains relative-only and existing realpath confinement stays enforced.
- [x] Unit (`test/file-explorer.test.js`): protected/internal paths remain read-only even though
      visible: their views hide upload/new-file/new-folder/Edit controls, and backend create/upload/edit
      helpers independently reject writes there.
- [x] Unit (`test/file-explorer-auth.test.js`): the resolved approved-user flag reaches the explorer
      authorization check (no undeclared shorthand/ReferenceError), while an unapproved user is
      still refused.
- [x] Unit: every entry plus nested Up/Root, middle-page Previous/Next, and preview Back/Share uses
      a distinct `action_id` across the entire modal, all matched by the shared pattern handler, so
      Slack accepts populated views instead of leaving the modal stuck on Loading with
      `invalid_arguments`.
- [x] Unit: previews expose confirmed Share + private *Send to me* controls, explain that a bounded
      preview leaves the real file complete, and expose Edit only when the channel mode and file are
      eligible. Edit metadata carries the open-time SHA-256; valid saves atomically replace the
      confined file, stale hashes preserve the newer version, and UTF-8/NUL/3,000-character limits
      are enforced. `.env*`, JSON/YAML/TOML, scripts, configs, extensionless files, and text with an
      unfamiliar extension are editable; binary/invalid UTF-8 and remaining protected paths are
      refused. Read-only/Worker/Auto/Full permission combinations are covered.
- [x] Unit (`test/file-download.test.js`, `test/file-explorer.test.js`): with a Public URL, every
      file preview exposes a distinct *Download* action, including files above Slack's sharing cap.
      Its opaque requester/channel/file grant is 10-minute and single-use; the public route repeats
      membership authorization, re-confines the opened descriptor against symlink races, streams
      the complete file with attachment/no-store/no-referrer/nosniff headers, creates no Slack file,
      and audits `channel_file_downloaded`. Malformed, traversal, escaping-symlink, expired, reused,
      and newly unauthorized requests are refused.
- [x] Unit (`test/file-editor.test.js`, `test/file-explorer.test.js`): eligible files up to 3,000
      characters expose both the native Slack Edit popup and the browser editor with distinct action
      IDs; larger eligible files remain browser-only. The browser button supports files beyond the
      Slack 3,000-character limit; its opaque grant is short-lived and single-use, exchanges into an
      HttpOnly/SameSite editor cookie, requires CSRF, serves no-store with CSP/no-referrer headers,
      provides Markdown preview, re-authorizes on exchange/page/save, atomically saves + audits, and
      rejects missing cookies, reused/expired grants, bad CSRF, and stale hashes without overwriting.
- [x] Unit (`test/file-explorer.test.js`, `test/file-upload.test.js`): writable views expose one
      browser-only *Upload files / folder* action, while read-only/protected destinations hide it;
      source regression checks ensure there is no native Slack `file_input`, Slack upload modal, or
      private-file download handler. The one-time browser grant exchanges for an HttpOnly/SameSite
      session, requires CSRF,
      re-authorizes on exchange/page/every file, enforces 200-file/250 MB session and 25 MB per-file
      limits, recreates safe nested paths, rejects traversal/protected segments, collision-renames
      without overwriting, and audits `channel_file_uploaded_in_browser` per saved file.
- [x] Unit (`test/settings-env-lifecycle.test.js`): a scheme-less Public URL is saved and read as
      an absolute HTTPS URL (including hostname-plus-path input), while explicit HTTP development
      URLs and empty values are preserved; browser upload links therefore cannot disappear solely
      because an operator entered the public hostname without `https://`.
- [x] Unit (`test/file-explorer.test.js`): writable views expose *New folder* for the directory on
      screen while read-only views hide it; creation is confined, trims a valid name, rejects empty,
      protected, traversal/separator, control-character, over-limit, and colliding names, and never
      replaces an existing file or directory.
- [x] Unit (`test/file-explorer.test.js`): writable views expose a unique *New file* action and a
      filename/optional-content modal. Creation is confined to the directory on screen, trims a safe
      name, accepts `.env*`, preserves UTF-8 initial text, uses exclusive creation, and rejects
      empty/protected/traversal/separator/control/over-limit names, NUL content, protected parents,
      file/folder/symlink collisions, and a parent swapped to an escaping symlink before mutation,
      without replacing or creating anything outside the root. Slack source coverage verifies
      requester/membership/mode reauthorization, `channel_file_created`, and immediate preview/editor
      refresh.
- [x] Interactive run footers show `💻` and `📂` as adjacent actions; the Files value is bound to
      the current requester/channel/thread, native-stream and classic fallback trailers match, and
      clicking it opens the explorer without another AI turn.
- [x] Unit (`test/file-button-actions.test.js`): message file buttons accept the originating user
      or a gateway admin, still reject another ordinary user, and all action notices carry the
      button's source thread (with the Slack message envelope as an older-control fallback).
- [x] Unit (`test/review-file-buttons.test.js`, `test/slack-progress.test.js`): final answers naming
      one or several existing confined files produce deduplicated requester-bound direct-preview
      buttons (maximum five) in mention order. Inline absolute paths, legacy Markdown paths,
      percent-encoded spaces, and source-line suffixes resolve; missing/malformed/outside-root paths,
      directories, escaping symlinks, and absent run/requester context do not. The direct action
      opens the existing preview with its parent as Back state, while the click path retains the
      explorer's authorization, membership, and realpath checks.
- [ ] `/files` at conversation top-level opens the native file explorer without starting a
      Claude/Codex run. At root, its title is the stored Slack channel name and its subtitle is the
      full absolute effective-root path; after nested navigation, the subtitle updates to that
      absolute directory, and Up/Root return only within the effective root. More than 18 items
      paginate, size metadata is shown, and all contained items—including dotfiles, `.env`, `.git`,
      confinement settings, instructions, memory, and complete skill trees—appear and can be
      previewed. Broken/escaping symlinks appear without an open control, and protected/internal
      paths expose no write controls.
- [ ] Use *Browse channel files* on a thread message, and typed `@bot /files` in that thread: both
      open the same explorer with the thread retained. (Slack custom slash commands cannot run in a
      thread, so the shortcut/button are the thread-aware entries.)
- [ ] An unauthorized user is refused; after an authorized user leaves the channel, a click in an
      already-open modal is refused. Forged state cannot change owner/channel, traverse `..`, open a
      path outside the confined root, follow an escaping symlink, or access a sibling channel.
- [ ] Preview a small UTF-8 text file → bounded inline preview; binary → metadata-only preview;
      >25 MB file → browse/preview remains available but no Share button.
- [ ] With a public URL configured, open both a small file and a >25 MB file and choose *Download*.
      Each browser transfer must contain the complete original bytes, create no Slack file, and
      audit `channel_file_downloaded`; the oversized preview still has no Share/Send button. Reuse
      an opened URL, leave the channel before opening another, and replace the target with an
      escaping symlink: each request is refused. Remove Public URL and confirm Download is hidden.
- [ ] Confirm Share → one Slack file copy lands only in the originating channel/thread and
      `channel_file_shared` is audited. Cancel → no upload. Missing scope, a deleted/raced file, or
      Slack upload failure shows a modal error without crashing the daemon.
- [ ] Confirm *Send to me* → the complete file lands only in the requesting user's bot DM and
      `channel_file_sent_to_user` is audited; changing the user's client network has no effect.
- [ ] With a public URL configured, *Upload files / folder* opens the browser uploader for the
      directory on screen. Choose multiple files and a nested folder; verify no Slack file is
      created, nested paths are preserved, empty folders are explicitly omitted, collisions are
      numbered, and every file audits
      `channel_file_uploaded_in_browser`. Reused/expired links, bad CSRF, changed membership/mode,
      traversal/protected paths, >200 files, >25 MB per file, and >250 MB total are refused.
      Read-only hides Upload; Full allows only an admin.
- [ ] In Worker/Auto mode, *New folder* creates one directory in the folder currently on screen,
      refreshes the explorer, and audits `channel_folder_created`. Read-only hides it; Full allows
      only an admin. Leaving the channel, losing authorization/mode, a protected or traversal name,
      and a file/folder collision refuse creation without changing the existing item.
- [ ] In Worker/Auto mode, *New file* creates a file with optional initial text in the folder on
      screen, opens its preview/editor, and audits `channel_file_created`. Verify `.env`, JSON, YAML,
      TOML, scripts, and extensionless UTF-8 files can be created/edited; an existing file, folder,
      or symlink is never replaced. Read-only hides the control; Full allows only an admin. Losing
      authorization/membership/mode, protected/traversal names, NUL/binary/invalid UTF-8 content,
      protected parents, and collisions refuse the write.
- [ ] In Worker/Auto mode, an eligible file up to 3,000 characters offers both *Edit* in the native
      Slack popup and *Edit in browser*; Slack fixes the native modal dimensions, while the browser
      provides the larger workspace. *Edit in browser* opens the public gateway editor in a new
      browser window, with full content and a live split preview for Markdown; Save changes the confined file and
      `channel_file_edited_in_browser` is audited. Read-only hides Edit; Full allows only an admin.
      Reusing/forwarding an already-opened link, leaving the channel, losing authorization/mode, or
      changing the file after opening refuses access/save and leaves the latest disk version intact.
- [ ] Remove the configured public URL → eligible files ≤3,000 characters retain only the Slack
      modal editor and continue auditing `channel_file_edited`; larger files expose no Edit button.

### MCP injection & tokens
- [x] Cumulative automated regression after Composio SDK mode: `npm test` — 412/412 passing on
      merged `main`.
- [x] Unit: Composio mode defaults to Personal; selecting SDK through the admin route does not
      clear any saved user/channel/org token, and switching back restores the exact token paths.
- [x] Unit: SDK settings expose only key presence/last four characters; the UI sends a replacement
      key only when edited, requires an explicit clear action, and explains that mode changes retain
      all credentials.
- [x] Unit: SDK identities are stable per Slack workspace + user/channel, session keys are isolated
      by identity + Slack thread + access class, mappings persist in SQLite, and stale remote
      sessions are recreated once.
- [x] Unit: SDK mode resolves independent personal/shared sessions; personal sessions allow their
      owner to manage connections, shared sessions allow management only under existing channel
      managing rights, and failure of one identity never substitutes or removes the other.
- [x] Unit: Claude and Codex inject SDK sessions through the local stdio bridge without putting the
      organization key on argv; the bridge rejects non-HTTPS/non-Composio session URLs and returns
      sanitized errors.
- [x] Unit: personal Composio and shared channel Composio are injected simultaneously with separate
      MCP names/headers in Claude and Codex; channel shared wins over org shared without replacing
      personal, and either connection may exist alone.
- [x] Unit/integration: an admin can atomically keep, replace, test, and clear one per-channel Make
      toolbox URL/key pair; only official HTTPS `*.make.com` and `*.make.celonis.com`
      `/mcp/server/<id>` URLs are accepted, partial pairs fail closed, and the probe performs only
      MCP initialization plus `tools/list` with bounded output, timeout, close, and sanitized errors.
- [x] Unit: complete non-clean Make toolbox configuration injects `make-toolbox` into Claude and
      Codex, including Claude Bearer headers and Codex's daemon-root 0600 secret bundle + broker,
      normal/resumed/fallback plumbing, settings allowlisting, and clean-mode removal; leak tests
      prove every connector key and the signed gateway capability are absent from Codex argv and
      child env.
- [x] Unit: child environment inheritance uses exact reviewed names only; unknown future
      `ANTHROPIC_*`, `OPENAI_*`, `CLAUDE_*`, `CODEX_*`, `XDG_*`, and `LC_*` variables fail closed.
- [x] Unit: the Admin Tools card exposes URL, masked/reveal key, Test connection, and explicit Clear
      controls, preserves a stored key when left untouched, and repaints URL/key/state from the
      authoritative save response.
- [x] Unit: `noDefaultTokens` refuses org shared Composio while preserving personal/channel
      Composio; clean mode removes both identities.
- [x] Unit: the injected operating guide frames `composio-agent` as the model's OWN account and
      `composio-user` as the requester's, resolves by pronoun app-agnostically (“verify my email” /
      “verify your email”), uses the only-connected account when there is no pronoun and asks when
      both have the app, points at each account's connected-app list, forbids silent substitution,
      and no guide file still names the bare legacy `composio` server or the retired
      “channel/company account” vocabulary (`test/composio-guide.test.js`).
- [x] Unit: App Home Composio key entry — an invalid/whitespace-bearing key is rejected in-modal and
      stores nothing, a valid one is trimmed and saved for the SUBMITTER only (with its optional
      label) then re-renders Home, disconnect clears key + label, the modal never pre-fills or echoes
      a stored key, and the buttons disappear in SDK mode.
- [ ] Live Slack: open the App Home tab → "Connect my Composio key" → paste a key in the modal →
      Home repaints to "✅ Composio personal — your account" with no message posted anywhere; the
      next run injects that key as `composio-user`. "Disconnect" (with its confirmation) reverts to
      the org-default/❌ line.
- [ ] Set channel Skills + user Composio + org-default Toolbox live → a run injects exactly those;
      Skills/Toolbox retain channel → user → org while Composio uses its two independent paths.
- [ ] Library favorites appear as native skill-stub folders (`.claude/skills/<slug>/SKILL.md`) when a
      skills token is active — frontmatter name+description, body routing to `library_get_skill_file`
      with the original library name; stubs are pruned when the token/favorite is removed (and under
      clean mode). A local (admin-granted) skill of the same name is never clobbered by a stub, and
      granting a skill replaces a same-named stub. The legacy `CLAUDE.md` favorites block is stripped.

### Trusted bot apps & working folders
- [ ] A message from a `trustedBotApps` bot with NO mention is ignored; WITH `@bot` + an approved
      author it runs (loop-guard bypassed, gates still enforced).
- [x] Unit: Admin UI API docs retain the verified Make `slack:CreateMessage` requirements together:
      the bot's mention/member ID, approved Make bot user, trusted Make app/bot IDs, both apps in the
      channel, and root `thread_ts` fallback.
- [ ] Live: export the Make module and confirm `mapper.text` begins with the bot's member-ID mention; post it
      through the approved/trusted Integromat bot and verify the bot replies in the original root
      thread when the source event is either a channel message or a threaded reply.
- [ ] Set a channel's working folder to a real project via the picker → the run happens there and an
      existing `CLAUDE.md`/`AGENTS.md` is not overwritten; clearing it reverts to `~/ChannelGate/<platform>/<slug>`.

### Admin UI
- [x] Settings saves are a DIFF under a version check: a partial save leaves every key it does not
      carry intact (a `scheduleMaxPerChannel` save cannot revert `channelTemplate.effort`); a save
      echoing a stale `settingsVersion` is refused with `409`, writes nothing, and returns the
      current settings payload (engines + platforms + slack included, so the page can repaint from
      it); two admins changing different fields both survive once the second re-reads; a caller
      that sends no version is merged in as before; and the page's Save reads the same
      `readSettingsForm()` the baseline was captured from (automated:
      `test/settings-save-version.test.js`, `test/admin-save-reconciliation.test.js`).
- [x] Live (browser, scratch daemon): changing one field sends exactly
      `{that field, settingsVersion, connectSlack}`; a concurrent daemon-side write then makes the
      next Save show "changed elsewhere: …", repaint the newer values, and land on a retry with the
      other writer's values intact.
- [ ] Sidebar shows Overview/Conversations/Users/Automations/Activity/API/Settings with the
      #makeitfuture. wordmark; Conversations is master-detail. Poppins loads from `/fonts/`
      (self-hosted — no external font/CDN requests anywhere).
- [x] Unit: every sidebar page maps to a canonical URL; direct requests serve the authenticated
      admin shell, and the client wiring uses push/replace state plus `popstate` restoration.
- [x] Unit: `test/host-guard-recovery.test.js` proves the Host/Origin 403 carries
      `code: "host_not_allowed"`, never echoes the Host header it refused, leaves the shell itself
      reachable so the recovery screen can render, spares loopback, and that the client preserves
      `status`/`code` and paints a fatal panel (loopback hatch + Public URL + `CG_ALLOWED_HOSTS`)
      instead of logging to the console. `test/host-guard.test.js` pins the `publicUrl` spellings
      that must grant a host — with scheme, with port, with trailing slash, with a path, and
      scheme-less — while staying fail-closed on unparseable input and never granting a neighbour.
- [ ] Live: reach the gateway through a tunnel whose hostname is NOT allowlisted and confirm the UI
      shows the recovery panel (not a blank "Loading…"); then set Settings → Public URL from
      `http://localhost:<PORT>`, save, and confirm the tunnel works with no restart.
- [x] Unit: `test/asset-versioning.test.js` proves the shipped shell carries no unsubstituted
      `{{ASSET_V}}`/import-map placeholder, that `/`, `/index.html`, every view path, and a
      conversation detail path all serve the STAMPED shell with `Cache-Control: no-cache` (nothing
      can serve the raw template), that every `./sibling.js` app.js imports appears in the import
      map pointing at the content-stamped URL, that the stamp is content-derived and stable across
      calls, and that each stamped module URL is served as JavaScript with `no-cache`. Regression
      guard for the split module graph that took the UI down with "does not provide an export named
      'accessGrantSkillOptions'".
- [ ] Live: after a `git pull` + restart, hard-reload the admin UI once and confirm view-source
      shows `/app.js?v=<hash>` plus an import map whose entries carry the SAME hash; then reload
      normally (no hard reload) and confirm the page loads — a stale sibling module must be
      impossible, not merely unlikely.
- [x] Unit: channel, DM, and group selections map to validated nested conversation URLs; direct
      detail requests serve the admin shell, row links update history, and initial/popstate routing
      restores the matching selection key.
- [x] Unit: MCP checklists request the editor's effective engine, keep Claude and Codex selections
      independently, save both sanitized allowlists for channels/DM templates, and preserve saved
      offline entries when discovery is temporarily unavailable.
- [x] Unit: `test/admin-save-reconciliation.test.js` proves a successful channel PUT replaces
      stale cached `allowedCodexMcps`, `allowedMcps`, and `skills` from its authoritative `meta`,
      recomputes token-presence helpers, and wires the channel editor to consume that response.
- [x] Unit: the same suite proves global Settings separates fetch from paint, consumes the
      successful PUT representation directly (including `showMessageCost:false`), and does not
      issue a redundant post-save settings GET.
- [x] Unit: Codex app-server discovery initializes the experimental API, groups active
      `codex_apps` tools into one checkbox per family, excludes gateway identity servers and
      schema/auth metadata, captures sanitized connector IDs, leaves optional app families disabled
      on a cold timeout, and resolves legacy family selections to default-deny connector `apps.*`
      plus explicit per-server launch overrides for normal, resumed, fallback, empty-selection, and
      clean runs.
- [x] Unit: gateway MCP config carries the active engine; list/add/remove select Claude's
      `allowedMcps` or Codex's `allowedCodexMcps` accordingly, and Codex persistence keeps only the
      stable family/server identity rather than runtime schemas or connector IDs.
- [x] Live (2026-07-24): with all apps default-denied, discover Hotline's connector ID from the
      active app-server catalog, launch an isolated read-only Codex turn, and verify
      `hotline.get_local_hotline` completes successfully.
- [ ] Live: switch a channel between Claude and Codex in the Admin UI; verify the visible catalog
      changes without losing either selection set, Boost.space appears for Codex, selected families
      alone are available on the next Codex turn, and clean mode exposes no optional family.
- [ ] Live: open each sidebar page, refresh it, and verify the same page remains selected; then use
      browser Back/Forward and confirm both the URL and selected page move together. Repeat after
      selecting a channel, DM, and group; each refresh must reopen the same detail.
- [ ] The channel list is sorted alphabetically by name (case-insensitive), before and after filtering.
- [ ] Channel detail has a **Memory** sub-tab: opening it loads the channel's `MEMORY.md`
      (`GET /api/channels/:id/memory`); editing + "Save memory" writes it back (`PUT`), and the
      change is visible in the file on disk. With folder memory off, it shows a warning but still edits.
- [ ] Channel detail has an **Instructions** sub-tab editing the REAL `CLAUDE.md`: the
      gateway-managed block (global instructions + Slack guide, `<!-- GATEWAY-INSTRUCTIONS -->`
      markers) shows grayed-out with a "Settings → Behavior" link; the textarea below holds ONLY the
      channel-owned section. Save (`PUT /api/channels/:id/instructions` with `{channel, hash}`)
      rewrites the file as block + channel text; a concurrent file change (agent rule-write) makes
      the save 409 instead of clobbering, and a second Save after the auto hash-refresh applies.
- [ ] Channel `CLAUDE.md` persistence: text written below the managed block (by hand, UI, or the
      `update_channel_instructions` MCP tool) survives re-provisioning, new sessions, `/clear`, and
      a global-instructions change (which refreshes ONLY the block). Deleting a marker line
      self-repairs on the next run without losing the channel section. Legacy generated files
      migrate once: old global/stub/Slack-guide/memory-block boilerplate collapses into the managed
      block + a seed stub; genuine per-channel text is preserved as the channel section.
- [ ] `update_channel_instructions` (gateway MCP): "add a rule that X" from Slack appends to the
      channel section in every mode (incl. read-mode — the daemon-side MCP writes outside the
      sandbox); `mode:"replace"` is refused for non-admins. A custom-working-folder channel gets a
      plain append to the project's own file (no managed block injected).

### Channel memory (skill-packaged)
- [ ] With memory on, provisioning writes `.claude/skills/channel-memory/` (SKILL.md + the
      `.gateway-memory-skill` marker), seeds `MEMORY.md` as an index + a `memory/` dir, and puts
      NOTHING memory-related into `CLAUDE.md`'s gateway block. Turning memory off removes the
      skill (marker-guarded — never a real granted skill) but leaves the memory files; back on
      restores the skill.
- [ ] `update_channel_memory` (gateway MCP): `add` appends one index line; `replace old→text`
      edits in place; `remove old` drops matching lines; `write_topic` creates
      `memory/<slug>.md` and reminds to keep an index pointer. Works in a read-mode channel
      (daemon-side write). Responses include the usage meter.
- [x] Unit: Claude config, Codex argv, and Codex's secret bridge preserve the daemon-resolved
      `CG_FS_ROOT` + `CG_WORKSPACE_DIR`; a real stdio gateway MCP launched with a different isolated
      `HOME` writes default memory under the daemon workspace and custom memory to the exact project
      folder, never under ephemeral engine state (`test/mcp-config.test.js`, `test/codex-args.test.js`,
      `test/run-engine-mcp.test.js`, `test/secret-env-bridge.test.js`,
      `test/mcp-control-plane-approval.test.js`).
- [x] Uncapped store: content well beyond the former character limit persists atomically in
      Markdown; validation failures leave both index and topic files untouched
      (`test/channel-memory.test.js`).
- [x] Batch semantics: `add` lands inside its named `section` (case-insensitive) or at the end;
      an exact duplicate add is a no-op with a note; `replace` swaps the whole line and rejects a
      substring matching two lines; headers/seed note are never replace/remove targets;
      instruction-shaped (`ignore previous instructions`, `[system]`), token-shaped (`xoxb-…`)
      and invisible-Unicode content is refused before any write (`test/channel-memory.test.js`).
- [x] Catalog injection: a fresh session gets only source/topic names, counts, and directions to
      bounded search/read tools—not the memory body. Nothing is injected for an empty store, a
      clean run, or memory off (`test/channel-memory.test.js`, `test/memory-snapshot-run.test.js`).
- [ ] Live: in a channel with a saved fact, start a NEW thread and ask about it without hinting —
      the answer comes from the injected snapshot with no Read of MEMORY.md in the activity log.
- [x] Background review trigger: trivial prompts/slash commands never review; every N non-trivial
      turns per channel review ("interval"); a correction/preference/decision-shaped message
      reviews immediately ("signal") and restarts the cadence; a turn where the model called
      `update_channel_memory` itself resets the counter; interval 0 disables
      (`test/memory-review.test.js`).
- [x] Background review E2E (stub `claude`): a saving review posts `🧠 Memory updated — <verdict>`
      in the thread, banks a usage row with `task_kind = memory_review`, logs a `memory_review`
      event with `saved` + `reason`, and was launched with ONLY the gateway MCP server carrying
      `CG_TOOLSET=memory-review` (no Composio/Skills identities) plus `--disallowedTools`; a
      "Nothing to save." review posts nothing; one review per channel is queued at a time; memory
      off / clean mode never reviews (`test/memory-review.test.js`, `test/claude-args.test.js`).
- [ ] Live: tell the bot a preference in one message ("from now on keep replies short") in a
      channel where the model does not save on its own → within a minute the thread shows
      `🧠 Memory updated — …`, MEMORY.md contains a declarative line under People & preferences, and
      the Audit feed shows `memory_review` + `memory_saved` (review: true) rows.
- [ ] Settings: the three review fields (interval, model, notify) round-trip through
      `GET/PUT /api/settings`; a negative interval or a model string with shell characters is ignored.
- [ ] Live save loop: tell the bot a durable preference ("remember: reports go out Fridays") →
      it calls `update_channel_memory`; a NEW thread (fresh session) asked about report timing
      reads MEMORY.md / triggers the channel-memory skill and answers from memory.
- [ ] Admin UI Memory tab describes uncapped Markdown storage plus the derived SQLite FTS index,
      shows stored characters/facts and topic files, and refreshes those counts after save.
- [ ] Overview is the default landing view: 7 KPI tiles (Token Est Cost in orange, separate Claude
      Cost and Codex Cost, Runs with avg value, Active users, live Active sessions, Tokens with
      in/out sub), the orange hero cost chart
      (gridlines + dated peak) and runs/tokens sparklines, runs-per-user bars (descending,
      VISIBLE fills), and
      per-channel runs+estimated-value bars render; the refresh icon button reloads. Large totals show
      whole dollars (e.g. `$365`, not `$364.6213`). DM rows in the channel bars show the person's
      name ("<Name> (DM)") when resolvable.
- [ ] Overview's **Active sessions** tile opens a live modal. Each in-flight row shows conversation,
      author, elapsed time, and the effective engine/model; a Claude→Codex fallback updates the row,
      DM rows read "<Name> (DM)" instead of `dm-U…`, and `/api/active-runs` exposes neither prompt
      text nor attachment paths. Without refreshing the page, the KPI/modal update on start,
      runtime resolution/fallback, and finish; elapsed time ticks while open. Disconnect/reconnect
      `/api/active-runs/stream` and confirm its initial full snapshot reconciles missed changes.
- [ ] Overview **harness dropdown** defaults to All. Selecting Claude or Codex reloads and scopes
      every KPI and chart, including active sessions and top skills, to that harness; switching back
      to All restores the combined totals. Claude Cost and Codex Cost sum to Token Est Cost when all
      priced runs are included.
- [ ] Overview **range dropdown** (Today / Last 7 days / Last 30 days / This month / Last month /
      This year / Last year) reloads on change and re-scopes every tile + chart. Bucket granularity
      adapts: Today = hourly points, week/month = daily, year = monthly; empty ranges (e.g. Last year
      with no data) render zeros/flat without error.
- [x] Unit: `usageDashboard` applies `harness=claude|codex` to totals, series, per-user and
      per-channel rollups; top-skill usage accepts the same engine scope; omitted/unknown harnesses
      safely resolve to All (`test/dashboard-harness-filter.test.js`).
- [x] Airtable: active dual-engine live definitions `UI-DASH-01C` (Claude) and `UI-DASH-01X`
      (Codex) use the Admin UI plus the private `cg-testing-*-auto` fixtures and require matching
      UI screenshots and API JSON evidence for all seven KPIs, charts, and live Active sessions.
- [ ] `GET /api/dashboard?range=…&harness=…` returns `{ range, harness, unit, start, end, totals
      (including Claude/Codex cost), series (gap-filled, one point per bucket), byUser, byChannel }`;
      an unknown range falls back to `last30` and an unknown harness falls back to `all`.
- [ ] Settings: vertical section nav (Connection / Agent defaults / Integrations / Access &
      security / System); every section stays in the DOM and ONE sticky Save persists all of them;
      dirty tracking shows "Unsaved changes" on any edit and "All changes saved" after save/boot.
- [ ] Token fields (Slack bot/app/signing, org-default Composio/Skills/Toolbox, per-channel and
      per-user) pre-fill the stored token masked (first few + last 4) with an eye toggle that reveals
      the full value; leaving a field untouched and saving keeps the stored token; typing a new one
      overwrites it. Slack reconnect fires only when a Slack token is actually changed.
- [ ] A DM using the User/Admin template reflects the template's config; editing the template applies
      across DMs; a per-DM custom config overrides.
- [ ] The new-channel template defaults to Autonomous + approved-domain network, persists with the
      global Settings save, is copied on first registration, and never overwrites an existing channel.
- [ ] Setting an admin password gates the UI (login required); "Remove password" reopens it;
      `/api/health` stays reachable without a session.

### Gateway-usage skill (Slack operating manual)
- [ ] Provisioning any channel writes `.claude/skills/gateway-usage/` with `SKILL.md`, the
      `.gateway-usage-skill` marker, and `references/*.md` (reminders, tables, canvases, mentions,
      writing-replies, messages, reading, memory-and-rules, background-jobs, administration). Present
      in EVERY mode, including clean mode.
- [ ] Provisioning creates the relative `.agents/skills → ../.claude/skills` directory symlink, so
      Codex discovers the same gateway-usage, memory, granted, and library skills as Claude; repeated
      provisioning is idempotent, while an existing `.agents/skills` entry or symlinked `.agents`
      parent remains untouched.
- [ ] The channel's `CLAUDE.md` gateway block no longer contains the inline Slack format guide
      ("Slack replies — keep them SHORT"); an existing folder that had it gets it stripped on the
      next run (default block) — replies still render (mrkdwn backstop) and `@Name` still pings.
- [ ] `get_gateway_guide` (any allowed user) lists the guide files and flags default-vs-override;
      with `file:"references/reminders.md"` returns that file's content.
- [ ] `update_gateway_guide` (ADMIN) with `file` + `content` overrides one file; the next message in
      ANY channel shows the edited content in its folder while un-edited files stay default (overlay
      merge). A non-admin author is refused. Path traversal / non-`.md` / empty content are rejected.
- [ ] `reset_gateway_guide file:"<one>"` restores just that file to the built-in default (others stay
      overridden); `reset_gateway_guide` with no file drops ALL customizations and prunes any
      override-only reference from the folders on the next run.
- [ ] The built-in default lives in git (`src/gateway/gateway-usage/`); a `git pull` that changes a
      default file surfaces in channels that never overrode it, and overridden files keep the override.
- [ ] An expired/missing Claude or Codex login request is answered with host-side recovery guidance:
      access the gateway computer/VPS, authenticate the relevant CLI with the operator's own
      subscription or API key, and never paste engine credentials into Slack.

### Admin UI — 2026-07 redesign
- [ ] No emoji anywhere in the UI chrome (icons are inline SVG); reveal-eye, folder rows, offline
      badge, status dots all render identically across browsers.
- [ ] Conversations list: three groups (Templates / Channels / Direct messages) with capability
      color dots (read=light teal, worker=teal, autonomous=amber, full=red, lean=gray); segmented
      All/Channels/DMs filter and search combine; 30-day cost badges appear when the dashboard API
      responds and are absent (no errors) when it doesn't.
- [ ] Channel detail tabs are Access / Tools / Runtime / Instructions / Memory. Access: clicking a
      capability radio-card selects it (Full access is red-treated + admin-tagged; Custom reveals
      the four raw flag checkboxes); the two access dropdowns show live per-option help; network is
      a switch row. Tools: MCP + skills checklists filter and show "N of M enabled"; offline servers
      carry a badge. Runtime: engine/model/effort + working folder + memory/nudges/org-token toggles.
- [ ] One sticky save bar per detail: any Access/Tools/Runtime edit shows "Unsaved changes";
      Discard restores the saved state; Save PUTs the FULL meta payload (same fields as before the
      redesign), updates the header pill + list row, then hides. Instructions & Memory are editor
      cards with their OWN Save and never trigger the save bar. Switching conversation with unsaved
      changes asks for confirmation.
- [ ] Live save reconciliation: enable Boost.space plus a Claude MCP/skill, save, switch to another
      conversation and back, and verify every returned selection remains checked without a browser
      reload. Disable Settings → Slack replies → footer cost, save, and verify the checkbox remains
      off immediately and after a hard reload; the next Slack reply omits only the dollar segment.
- [ ] Users: table rows show role chips, personal Skills counts and C/T token state; clicking a row opens
      the edit drawer; Save from the drawer persists name/approved/admin/tokens (unchanged PUT) and
      the drawer stays on that user; "+ Add user" reveals the add form; adding opens the new user.
- [x] Browser (engine-independent, disposable Chromium fixture): `test/user-skills-browser.test.js` uses the real admin UI/API
      and disposable users U_EMPTY (no skills) and U_SKILLS (alpha + offline-skill), with alpha/beta
      and 30 long names in the available catalog. Run with `CG_BROWSER_MODULE=/path/to/playwright/index.mjs
      node --test test/user-skills-browser.test.js`. Expect counts 0/2; filter for beta, check it,
      Save and reload: count 3, all three grants persisted, drawer stays editable. At 1600px the
      editor is at least 600px wide; at 1100/390px it stacks above the table without horizontal
      editor overflow, with reachable Save/Close. No browser exceptions. No engine is spawned;
      Claude/Codex cannot affect this browser-only behavior.
- [ ] Live operator: repeat the preceding counts/edit/reload/resize actions on disposable users in
      the deployed Admin UI. Fixture browser evidence does not count as a deployed live pass.
- [x] Airtable: `UI-USERS-SKILLS-01` defines the corresponding engine-independent acceptance case.
- [x] Unit: `test/user-search.test.js` proves `GET /api/users?q=…` folds case and accents, ANDs
      terms across name / Slack ID / visible role / configured token provider, returns an empty
      object for no matches, searches only the masked representation (never stored secret values),
      and that the Users page carries the debounced server request plus clear control while keeping
      table results separate from the full user directory.
- [ ] Live (Admin UI, engine-independent): open Users with fixtures covering Admin, Approved and No
      access plus configured/missing Composio and Toolbox tokens. Search by partial mixed-case name,
      Slack ID, role, provider, and a two-term combination; confirm only matching rows remain. Enter
      a junk query and confirm the explicit no-match row; clear with × and Escape; select a row,
      filter it out and confirm the drawer closes; resize to 390px and confirm search + Add user
      remain usable without horizontal page overflow.
- [x] Airtable: active engine-independent live definition `UI-USERS-SEARCH-01` covers masked
      server-side search, UI debounce/race behavior, clear/no-results states, and secret non-match.
- [ ] Settings danger zone: Reset all channels' access / Remove password / Restart daemon /
      Disconnect Slack live in the red zone; each opens the branded confirm dialog (danger-tinted
      confirm button, Escape cancels, backdrop cancels); reset completion shows an in-app notice
      (no native confirm()/alert() anywhere).
- [x] Unit: settings search + scroll-spy rules (`test/settings-single-page.test.js`) — AND-ed terms,
      typography folding, section title/description folded into every card, "no match" only when the
      page is actually indexed, spy skips filtered-out sections and picks the last one at the
      bottom; plus the markup contract (one stacked page, `#set-<section>` ids + headings + jump
      links in a sticky left rail with search alone in the top bar, no pane show/hide left anywhere)
      and an end-to-end index built from the real
      index.html (xoxb → Connection, composio → Integrations, danger zone → System, …).
- [ ] Live (Settings is ONE page): every section is visible by scrolling — no pane swaps anywhere.
      Clicking a left-rail jump link scrolls to that section, lands it clear of the sticky bar,
      marks it in the rail, and writes `/settings#set-<section>`; reloading that URL restores the same
      position; scrolling by hand re-marks the rail as you pass each section; scrolling to the
      very bottom marks the last section.
- [ ] Live (Settings search): `/` (and ⌘/Ctrl-K) focuses the box, typing narrows to matching cards
      only, sections with no hits disappear and their left-rail links dim, the page lands on the first
      surviving section, Esc / × / "Clear search" restores everything, and a junk query shows the
      "No settings match" line. Typing in the search box must NOT flip the save bar to "Unsaved
      changes"; with a search active, changing a visible field and saving still persists every
      section (hidden cards are hidden, not unmounted). API docs → "generate a token" jumps to the
      HTTP run API card and pulses it.
- [ ] Settings chip editors (trusted bot apps, network egress domains): Enter/comma adds a chip,
      × removes, Backspace on empty removes last; saving persists the same comma-separated values
      as before the redesign.
- [ ] Automations search filters live by channel name, resolved DM person, title/prompt, friendly
      timing, and raw cron; unmatched groups disappear and a junk query shows the no-results card.
      DM headings say `DM · <person>` rather than `dm-U…`. Rows show Daily / Weekdays / Weekly /
      Monthly / Hourly wording (raw cron remains available as hover/advanced detail), invalid custom
      cron still warns, last-run status has a green/amber dot, enable autosaves, and Delete confirms.
- [ ] Click the non-control area of an automation row: a large editor opens with conversation,
      task type, last-run status, name, enabled state, timing controls, notification/person,
      delivery, and the full saved prompt.
      Press Enter/Space on the row's details button to verify the same keyboard path; then use
      Cancel, ✕, Escape, and the backdrop and confirm each closes without saving. Checkbox,
      notification, person-ID, and Delete interactions must not open the modal.
- [ ] Edit an automation in one save: change name, enabled state, Daily/Weekdays/Weekly/Monthly/
      Hourly timing (and one custom cron), notification target, direct-channel/new-thread/daily-thread
      delivery, and multiline prompt. The modal closes and a hard reload shows every value; the next
      execution uses it. Invalid cron, missing notify person, and whitespace-only prompt are refused
      with the draft intact and no partial mutation. Direct-channel delivery emits no Running anchor;
      new-thread emits one per run; daily-thread reuses one per local day.
- [x] Automated contract: atomic full-edit validation, DM-name resolution, editor/search markup,
      direct-channel anchor suppression, trusted notification prefix, and daily-thread freshness
      (`test/schedule-prompt-editor.test.js`, `test/schedule-daily-thread.test.js`,
      `test/deliver.test.js`). Live dual-engine acceptance: Airtable `AUT-UI-01`.
- [ ] Activity: totals strip renders; text/channel/user/engine filters combine; "Show more" pages
      50 rows at a time from the cached fetch; Codex Standard API-equivalent values show the `*`
      footnote and are not described as billed spend.
- [ ] Login page carries the brand (wordmark, Poppins, orange primary button) and still signs in.

### Scheduling & reminders — "AI is waiting on you" follow-ups (Slice 8.8)
- [ ] ONLY "AI is waiting for your decision" threads qualify: the bot must have taken part
      (@mentioned or posted, `aiInvolved`) AND spoken LAST. Nothing else is ever reminded.
- [ ] Human-to-human replies you owe are NEVER reminded: A @mentions the bot, the bot replies, then B
      posts (a human) last → at digest time NOBODY gets it (the bot didn't speak last).
- [ ] Purely human-to-human thread (A ↔ B, bot never involved) → observed but NEVER in anyone's digest.
- [ ] AI-waiting case: A @mentions the bot and the bot replies (bot spoke last) → at digest time A
      (a participant) has the thread; a bystander who never posted does not.
- [ ] A replies in that thread → it clears automatically for A (bot is no longer the last author).
- [ ] A reacts ✅ on the thread → it leaves A's list; removing the ✅ brings it back; after ✅ a new
      bot message (bot speaks last again) re-opens it next digest.
- [ ] A scheduled digest with one listed thread gets ✅ from its recipient → that source thread is
      dismissed, the visible digest reaction remains, and the next digest does not repeat it.
- [ ] A scheduled digest with multiple listed threads gets ✅ from its recipient → every visibly
      listed source thread is dismissed from that snapshot; an overflow item represented only by
      “…and N more” remains pending.
- [ ] Remove ✅ from a scheduled digest → only done markers created by that digest reaction reopen.
      If A added a newer ✅ directly on one source thread, that thread stays dismissed.
- [ ] A different user cannot apply or remove a digest snapshot's dismissals; unknown/expired digest
      messages fall back to the existing direct-thread reaction behavior.
- [ ] Restart after a digest is sent but before its ✅ → the SQLite snapshot still resolves every
      listed source thread. Snapshots older than 14 days are pruned.
- [ ] A tracked `ack:true` reminder still resolves its acknowledgment chain before the follow-up
      digest handler sees the shared ✅ reaction.
- [ ] Digest copy reads "🤖 I'm waiting on your decision in N thread(s):" — no "from @bot" per line.
- [ ] Scheduled digest footer reads "React ✅ to dismiss all listed threads"; the on-demand
      `/pending` report keeps its direct source-thread dismissal guidance.
- [ ] At 08:00 / 14:00 (Europe/Bucharest) each approved user with ≥1 waiting thread gets ONE DM
      with permalinks; a user with none gets nothing. (Requires bot scope `im:write` — reinstall.)
- [ ] On-time fire: with the daemon awake across a slot time, the digest goes out within a minute of
      the slot (e.g. 08:00) and the slot's durable marker (`_meta` key `followup_digest_last:<hour>`)
      is set to today's date — the next minute tick does NOT send again.
- [ ] Late catch-up after sleep: machine asleep (or daemon down) at 08:00, wakes/starts at 09:30 →
      the 08:00 digest fires on the next tick (~09:30), not silently skipped for the day. If BOTH
      08:00 and 14:00 were missed (wake after 14:00), ONE catch-up DM is sent and both slot markers
      are recorded — never two identical DMs back-to-back.
- [ ] No double-send after restart: a slot fires (marker recorded), the daemon restarts later the
      same day → that slot does NOT fire again; the next day the same slot fires normally. A slot
      due while Slack is disconnected is NOT burned — it sends once Slack reconnects.
- [ ] DMs with the bot and channels it doesn't manage are never tracked; state prunes threads silent
      >14 days.
- [ ] On-demand `pending` / `/pending` in a thread/DM returns the same set of threads the next
      digest would DM (same `pendingForUser` query + shared formatter) — no divergence between the
      two surfaces.

### Scheduling & reminders — time zone, label, acknowledgment + escalation (Slice 8.9)
- [x] Unit: the daemon's zone is resolved from `TZ` (POSIX `:Zone` spelling included) or the
      platform, `zonedStamp` renders "2026-09-08 09:15 Europe/Bucharest (06:15 UTC)" (full UTC date
      when the two calendars disagree, no parenthetical on a UTC daemon, no throw on an unusable
      zone), and `nextCronRun` resolves the next fire in daemon-local time — null rather than a spin
      for an impossible cron (`test/schedule-timezone.test.js`).
- [x] Unit: `create_schedule` names the zone for a one-time schedule and adds the resolved next run
      for a cron, `list_schedules` repeats it, and the hint is silent on a UTC daemon
      (`test/schedule-timezone.test.js`).
- [x] Unit: the daemon's zone reaches a container as `TZ` at create (`-e TZ=…`) and in every exec's
      env-file, overriding a stale host value and read per run rather than frozen at import
      (`test/container-lifecycle.test.js`, `test/container-credentials.test.js`).
- [ ] Live (both engines): ask the agent to schedule "every weekday at 9:15" and then to say when it
      will run. Pass when the reply names the gateway's zone (not UTC) and `date` inside the channel
      container prints that same zone.
- [ ] `create_schedule kind:"reminder"` posts ONE "⏰ Reminder:" message (no "Running:" announce,
      no Claude run / token footer).
- [x] Unit: a reminder whose text already starts with "Reminder:" posts exactly one label; a
      deliberate double, a sentence that merely mentions the word, and a label-only prompt are left
      readable (`test/schedule-reminder-prefix.test.js`).
- [ ] Live: `create_schedule kind:"reminder" prompt:"Reminder: review the QA results"` posts
      "⏰ *Reminder:* review the QA results" — and the unacknowledged 2nd notice and creator DM
      carry the same single label.
- [ ] With `ack:true`, the message shows "React ✅ to acknowledge" and an ack entry is recorded.
- [ ] No ✅ within `ack_escalate_minutes` → a 2nd notice is posted (in-thread by default).
- [ ] Still no ✅ within `ack_dm_minutes` more → the creator gets a DM with a permalink and the
      ack entry is deleted. (Needs bot scope `im:write`.)
- [ ] A ✅ on the reminder message at any stage → "Acknowledged by @user", entry deleted, no further
      escalation — and it does NOT also register as a Slice 8.8 follow-up (ack branch wins).
- [ ] Acks survive a daemon restart (persisted in `config/acks.json`).

### Slack Lists (control MCP)
- [ ] `slack_list_create name:"…"` returns a `list_id`; the new List has a **Name** text column +
      a **Status** select (New / In progress / Done). `todo_mode:true` and a custom `columns` schema
      also work. (Needs bot scopes `lists:read` + `lists:write`.)
- [x] Creation calls `slackLists.access.set` with `access_level:"write"` and only the current
      conversation id before returning the List; a sharing failure is surfaced and the invisible
      standalone List is not remembered as an authorized channel tracker.
- [ ] `slack_list_add_item list_id:<F…> name:"…" fields:{Status:"In progress"}` adds a row with the
      title set and the Status select resolved from the label.
- [ ] `slack_list_items list_id:<F…>` lists each row's `Rec…` id, title, and other column values.
- [ ] `slack_list_update_item list_id:<F…> item_id:<Rec…> fields:{Status:"Done"}` changes that cell.
- [ ] `list_id` accepts a pasted List URL (…/lists/…/F…), not just the raw F-id.
- [ ] `slack_list_info list_id:<F…>` shows columns (name/key/id/type) and select choices for a List
      the bot didn't create, so items can be added/updated against the right column ids.
- [ ] Missing scope / inaccessible List returns a friendly one-line error (no crash), e.g. "add
      `lists:read` and `lists:write`…" or "share the List with the bot".
- [x] Every add/update/read/info operation calls `files.info` and refuses a List unless its
      `channels`/`groups`/`ims`/`shares` metadata contains the MCP process's current channel id;
      a pasted List id from another channel is not an ambient bot-token capability.

### A7 boundary hardening
- [x] API file downloads manually follow at most three redirects, DNS/SSRF-validate every hop,
      reject an oversized `Content-Length` before reading, and cancel a chunked stream immediately
      when it crosses 25 MB instead of materializing an unbounded `arrayBuffer`.
- [x] API completion webhooks use the same manual per-hop validation; POST bodies are retained only
      for 307/308 and browser-compatible 301/302/303 redirects become GET.
- [x] SQLite schema v8 repairs legacy duplicate channel slugs, clones the shared channel posture for
      renamed rows, and adds a unique index; new slugs are allocated inside `BEGIN IMMEDIATE` and
      remain stable after channel renames.
- [x] Skill revocation removes only real directories bearing `.gateway-managed-skill`; unmarked
      project-owned directories and all symlinks survive.
- [x] Any runtime-root/credential chmod or stranded-token cleanup failure aborts startup. A new
      install whose generated admin password cannot be persisted also rejects startup; existing
      configured installs retain their prior password posture.
- [x] A fresh install that ran `npm run setup` (so `settings.json` already holds the installer's
      `whisperEnabled` answer) still mints the first-boot admin password: the decision keys on
      operator-written keys, not on the file's existence; a file with any non-installer key
      (a token, a password, even an empty `publicUrl`) is an existing install and is left alone.

### Native Slack data tables (inbound + control MCP)
- [ ] Paste a native Slack `table` block with an `@gateway` request: the agent receives every row
      and column in display order as structured JSON, including pipes, commas, tabs, and embedded
      newlines without losing cell boundaries.
- [ ] Incoming `table` and `data_table` blocks work from top-level message `blocks`, direct legacy
      attachment entries, and nested `attachments[].blocks`; malformed rows/cells degrade locally
      instead of dropping the whole message or crashing the turn.
- [ ] `raw_number` cells remain numbers; `rich_text` cells retain readable link URLs, user/channel
      mentions, emoji, broadcasts, and list structure. A `data_table` caption is preserved.
- [ ] A table-only DM (or a channel message activated through the existing reaction bypass) starts
      a turn; an unmentioned channel message remains ignored by the normal mention gate.
- [ ] `slack_channel_history`, `slack_thread_replies`, and first-turn existing-thread replay include
      normalized table content rather than returning only the message fallback text.
- [ ] `slack_post_table caption:"…" headers:[…] rows:[[...]]` posts a Block Kit `data_table` into
      the CURRENT channel + thread with native headers, pagination, sorting, filtering, and an
      accessible top-level fallback `text`. It needs only the existing bot `chat:write` scope.
- [ ] Headers accept 1–20 columns and data accepts 1–100 rows; every row must match the header count.
      String cells become `raw_text`, finite numbers become `raw_number` (with display text) for
      numeric sorting, and empty strings display as an em dash.
- [ ] `page_size` accepts integers 1–100 (default up to 10 rows); `row_header_column` is zero-based,
      defaults to the first column, and must name an existing column for screen-reader row identity.
- [ ] More than 10,000 aggregate cell characters is refused before the API call with guidance to
      use `slack_upload_snippet`; a supplied `summary` is used verbatim and capped at 3,000 chars,
      while omission generates a compact caption/row/column fallback.
- [ ] The tool schema exposes no channel/thread argument: both ids come from `CG_CHANNEL_ID` and
      `CG_THREAD_KEY`, so the table cannot be redirected outside the requesting conversation.
- [ ] The injected `gateway-usage` skill routes small explanatory tables embedded in prose to GFM
      pipe tables in the streamed reply, sortable/filterable standalone datasets to
      `slack_post_table`, big/wide exports to CSV/TSV snippets, and editable trackers to Slack Lists;
      it forbids wide hand-aligned code-block tables and tells the AI not to duplicate a posted
      native table in prose.

### Slack file snippets (control MCP)
- [ ] `slack_upload_snippet content:<CSV> title:"…"` posts a FILE into the CURRENT thread; a CSV/TSV
      body renders as a scrollable spreadsheet grid (header row + "see it in full"). (Needs bot scope
      `files:write`.)
- [ ] The filename extension drives rendering: default `<title>.csv` → grid; `filename:"x.tsv"` →
      grid (tab-separated, safe for values with commas); `filename:"x.md"`/`.txt` → text snippet.
- [ ] `comment:"…"` is posted as the message alongside the file; the file lands in the thread
      (`thread_ts` = the current thread), not the channel root.
- [ ] Empty `content` is refused with a one-line message; no channel context returns a friendly error.
- [ ] Hard-scoped to the current channel — it never uploads to an arbitrary channel id.

### Native Slack charts (control MCP)
- [ ] `slack_post_chart chart_type:"line" ...` posts a Block Kit `data_visualization` into the
      CURRENT channel + thread with an accessible top-level fallback `text`. It needs only the
      existing bot `chat:write` scope.
- [ ] Line/bar/area accept 1–12 uniquely named series and 1–20 points per series; the first series
      defines category order, later series with the same labels in another order are normalized,
      and missing/extra/duplicate labels are refused before calling Slack.
- [ ] Pie accepts 1–12 uniquely labeled segments and refuses zero/negative values. Slack title
      (50), axis-title (50), series-name (20), and category-label (20) limits are enforced.
- [ ] Omitting `summary` generates plain-text fallback content from the exact chart data; a supplied
      summary is used verbatim after trimming and is capped at 3,000 characters.
- [ ] The tool schema exposes no channel/thread argument: both ids come from `CG_CHANNEL_ID` and
      `CG_THREAD_KEY`, so the chart cannot be redirected outside the requesting conversation.
- [ ] The injected `gateway-usage` skill routes visual trend/comparison/composition requests to
      `references/charts.md`, explains line/bar/area/pie selection and Slack limits, forbids silent
      truncation/invented values, and tells the AI to reply with only a short takeaway after posting.
      Its frontmatter description explicitly includes chart, graph, data visualization, trend, and
      comparison triggers so the skill loads before the agent chooses a visual.

### Scope self-check (boot)
- [ ] On boot the log shows `scope check: all N bot scopes granted` when the installed app holds
      every scope in `slack-app-manifest.json` (N = manifest bot-scope count).
- [ ] An app installed WITHOUT a manifest scope (e.g. remove `lists:write` and reinstall) logs
      `⚠️ missing bot scopes: lists:write …` and DMs every admin the "add these + reinstall" list.
- [ ] Repeated restarts with the SAME gap do NOT re-DM (throttled); the DM only re-fires when the
      missing set changes (a new scope goes missing, or a fixed one regresses).
- [ ] After the admin adds the scope + reinstalls, the next boot logs "all … granted" and sends no
      DM; a later regression to that same scope notifies again.
- [ ] The check never blocks the connection: a Slack/API hiccup logs `scope check skipped/error: …`
      and the bot still connects normally. State persists in `logs/scope-check.json`.

## Storage / SQLite (Slice 9)
- [ ] **Migration on boot:** starting the daemon on a machine with the pre-SQLite JSON files
      imports them once into `gateway.db` (log line "legacy JSON imported (…)"); counts match the
      old files; the JSON/JSONL files remain on disk untouched as backups.
- [x] Automated (OPS-02 regression — the legacy layout is what gets read): a fixture tree in the
      pre-rename shape (`channels/<slug>/meta.json`, `channels/<slug>/sessions.json`, plus
      `config/users.json` and `config/channels.json`) imports with `meta` and `sessions` counts
      above zero — both were always 0 — and each imported row equals its source file; an empty
      session id contributes no row, a channel folder with neither file does not break the sweep,
      and a `channels/slack/` platform folder is never imported as a phantom channel
      (`test/import-legacy.test.js`).
- [x] Automated (OPS-02 — the guarantees around it are unchanged): every legacy source file is
      byte-identical after the import; a second open does not clobber a later edit or resurrect a
      cleared thread map; a half-migrated tree whose files already sit at
      `channels/<platform>/<slug>/` is imported through the fallback
      (`test/import-legacy.test.js`).
- [ ] **Idempotent:** restarting does NOT re-import (record counts stay the same; `_meta`
      `legacy_imported=1`).
- [ ] **Schema versioning:** a fresh machine with no data creates the DB and applies all migrations
      (`PRAGMA user_version` = latest); appending a new migration + restart applies only the new one.
- [ ] **Multi-process:** the daemon and the spawned MCP-server process both read/write (e.g. create
      a schedule via the MCP tool while the daemon is running) with no "database is locked" errors.
- [ ] **Round-trips:** admin UI edits to users/channels/meta persist; a Slack thread resumes its
      session; a reminder + ✅ ack flows; a follow-up ✅ marks done — all across a restart.
- [ ] **Audit reads DB:** `GET /api/audit` and `/api/audit/events` reflect NEW runs (post-migration
      events appear, not just the frozen backup logs); month/channel/user filters work.
- [ ] **Portability:** `git pull` on a second machine with only a modern Node (24+) runs with no
      `npm rebuild` / native build step.

### Slack reads — this channel (bot token)
- [ ] `slack_channel_history` returns recent messages of the CURRENT channel (author + timestamp),
      oldest→newest; `limit` respected (max 100).
- [ ] `slack_thread_replies thread_ts:<ts>` returns that thread's messages in the current channel.
- [ ] The tools take NO channel argument and only ever read `CG_CHANNEL_ID` — there is no way to
      point them at another channel (confirm in code: the tool never forwards a model-supplied id).
- [ ] Bot not in the channel → a friendly "add the bot here first" error (no crash).

### Slack user MCP removed — Composio is the only external Slack MCP
- [ ] There is NO hosted Slack MCP and NO `connect_slack`/`disconnect_slack` tools; `buildMcpConfig`
      never injects a `slack` server (verify with `claude mcp list` on any run — only gateway +
      configured `composio-user`/`composio`/Skills/Toolbox appear).
- [ ] `namespacesFor` / `allowMatchesFor` do not include `mcp__slack`; a run's lockdown allowlist has
      no `slack` server. Cross-channel search/sends/canvases go through the Composio Slack toolkit.
- [ ] No `/oauth/slack/*` routes exist; the admin Settings has no per-user Slack OAuth fields (client
      id/secret, hosted MCP URL) and the Users table/drawer has no "Slack identity" column/row.
- [ ] The Slack app manifest declares only bot scopes (no `user` scopes, no `redirect_urls`); the
      boot scope-check still passes against the bot scopes.

## CLI integrations (2026-08-19) — switch retired 2026-09-03

**Retired 2026-09-03 (slice S1 of "Linux + containers only", `docs/plans/2026-09-03-linux-containers-only.md`
in the private repo):** the Settings card, the `cliIntegrations` setting, the install badges and the
read-only host-login links are gone; the catalog stays for the `/secrets` suggestions and the
write-deny list. The entries below that exercised the switch are replaced by the first three.
**Retired 2026-09-03 (Linux + containers only):** the network-approval, toolchain-grant and
host-credential entries went with the host runtime and the domain allow-list — the container image
ships the toolchain, a channel's credentials are its `/secrets` variables and its own HOME volume,
and *Allow network* is a switch the engines are told about, with no domain filtering. Kept as
history.

- [x] Every catalog entry's domains pass the shared network-domain normalizer; credential paths
      are HOME-relative and cannot escape upward (automated: `test/cli-integrations.test.js`).
- [x] The `/secrets` suggestions cover every catalog env name with no per-gateway switch; a stored
      `cliIntegrations` value is inert — the effective egress list equals the admin-typed base
      list, the credential read paths are the git/gh baseline only, and `/api/settings` carries no
      `cliIntegrations`/`cliIntegrationCatalog` (automated).
- [x] A bash+network host sandbox reads the git/gh baseline only — never a catalog CLI's saved
      login, which stays write-denied in writable folders; network-off channels get no credential
      carve-outs at all (automated).
- [x] Admin-run settings variant of a no-Bash admin+network channel includes the credential read
      re-allows; the shared variant of the same channel does not (automated).
- [x] Retired 2026-09-03 with the switch: "with Vercel enabled in Settings, a Bash+network channel
      runs `vercel deploy` in-sandbox" — in a container the CLI is in the image and the credential
      is the channel's `/secrets` variable (Airtable CLI-02/CLI-05).
- [ ] **Retired 2026-09-03 (Linux + containers only):** Manual: in an admin-mode, Bash-off, network-on channel, an admin author's `git push` over
      HTTPS authenticates; a non-admin author in the same channel still cannot read `~/.gitconfig`.
- [x] `normalizeRequestedDomain` accepts bare domains / wildcards / URLs (hostname only) and
      refuses IPs, localhost, single-label hosts; stored channel extras degrade to NO extras on
      any malformed entry; extras join only that channel's sandbox list (automated).
- [ ] **Retired 2026-09-03 (Linux + containers only):** the tool is gone. Manual: `request_network_domain` posts an Approve/Deny card any authorized user can approve;
      the domain lands in the channel card's "Extra network domains" field, works on the next
      message, and deleting it there revokes access. An invalid or already-allowed domain gets a
      refusal/no-op with NO card.
- [x] Retired 2026-09-03: CLI install detection and the Settings "installed" badges
      (`test/cli-detect.test.js` removed; `resolveBinPath` stays covered by
      `test/sandbox-toolchain.test.js`).
- [x] Toolchain read grants: the whole Node prefix is granted (not just the `node` binary); a
      symlinked binary grants BOTH the link and its realpath target; a real binary grants itself;
      `~/.local` is never granted wholesale and `~/.local/share` stays masked; only an ENABLED
      integration makes its CLI reachable; junk integration ids are ignored; paths outside HOME and
      anything inside the gateway root are dropped; a missing binary is skipped without throwing
      (automated: `test/sandbox-toolchain.test.js`).
- [x] Split-globals layout: a CLI whose package lives OUTSIDE the Node prefix grants the package
      root, so the shim's siblings and nested chunks are readable; the grant stops at the package
      and never exposes the whole `node_modules` tree or its parent; the emitted list is minimal
      (nothing already covered by a granted directory) (automated).
- [x] Toolchain grant wiring: a Bash or auto-mode channel gets the paths in `allowRead`, a
      read-only channel does not, they appear with network OFF too, and they never reach
      `allowWrite` while `~/bin` + `~/.local` stay write-denied (automated).
- [x] Codex toolchain parity: both confined permission profiles include every reviewed computed
      per-user toolchain path (including a split npm-global Vercel package), never promote those
      paths to write access, and the Codex child forces `NODE_USE_ENV_PROXY=1` so Node-based CLIs
      use the already destination-restricted proxy (automated: `test/codex-args.test.js`).
- [x] Codex launcher preservation: each confined run prepends a private bin containing only
      reviewed HOME-local CLI names as symlinks directly to real package launchers, so npm/npx keep
      their package-relative imports; the private bin is read-only and the full host
      `~/.local/bin` is never exposed (automated: `test/run-grant-isolation.test.js`,
      `test/sandbox-toolchain.test.js`; live Airtable cases DRV-01/DRV-02).
- [x] Claude launcher preservation: the stable content-addressed launcher dir under
      `<gateway>/runtime/toolchain-bin/` holds direct symlinks to resolved targets, is idempotent
      for an unchanged toolchain, materializes nothing on an empty toolchain, is prepended to
      PATH by `buildClaudeEnv` where a channel secret cannot override it, and its container is
      re-allowed only for write-capable channels (automated: `test/sandbox-toolchain.test.js`;
      live Airtable case CLI-12 — regression: a symlink-shim host lost node/npm/npx/supabase/vercel
      inside the Claude sandbox because per-file binds cannot materialize symlink entries).
- [ ] **Retired 2026-09-03 (Linux + containers only):** Manual (Linux, per-user toolchain): in a Bash channel whose node lives under `~/.local/bin`,
      `node --version`, `npm --version`, `npx --version` and (Vercel enabled) `vercel --version`
      all resolve inside the sandbox; with the grant removed each reports `command not found`.
      Verified 2026-08-26 against a real `claude -p` sandbox run on the Linux host.
- [ ] **Retired 2026-09-03 (Linux + containers only):** Manual (Linux Codex): in the same network-enabled channel, switch to Codex and verify
      `node --version`, `vercel --version`, and `vercel whoami` resolve in-sandbox without manual
      PATH or proxy exports and report the configured account.

## Per-channel browser isolation (`agent-browser`, 2026-08-27)

- [x] Namespace derivation: a channel's namespace is stable across turns, distinct per channel AND
      per platform, shell/socket safe (`^[a-z0-9-]+$`), bounded at 64 chars, and an unknown or
      missing platform resolves to Slack like every other stored record (automated:
      `test/browser-env.test.js`).
- [x] Fails closed on a missing identity: a caller with no slug still gets a namespace
      (`cg-unidentified`) rather than the OS user's DEFAULT namespace, which is shared with any
      `agent-browser` the operator runs by hand on the host (automated).
- [x] Injection: the namespace reaches both the Claude and the Codex child env; a spawn site that
      asks for none gets none (strict-MCP smoke and memory-review runs have no browser at all)
      (automated).
- [x] A channel cannot name its own browser: `AGENT_BROWSER_*` is reserved on write, `safeSpawnEnv`
      drops it at the runner boundary, and a hand-planted `AGENT_BROWSER_NAMESPACE` still loses to
      the gateway's own because the gateway-owned group is merged last (automated).
- [x] Warm pool: the namespace is part of the Claude pool's isolation fingerprint, so a pooled
      process can never keep an older channel's browser (automated via the fingerprint contract).
- [ ] Manual (per host): with `agent-browser` enabled in two channels, channel A opens a page and
      leaves it; channel B's first `snapshot` shows ITS own blank browser, not A's page. Repeat
      after a daemon restart.
- [ ] **Retired 2026-09-03 (Linux + containers only):** the Bash-sandbox rationale; the per-channel namespace entries above stand. Manual (per host): a fully sandboxed (non-admin, non-bash) run navigates a public page and
      reads the rendered snapshot — proving the MCP child still escapes the Bash sandbox that
      denies Chromium's `socket(AF_UNIX)`.

## Per-channel environment secrets (2026-08-26)

- [x] Case folding (ADM-010/SEC-02): a lowercase-but-otherwise-valid name normalizes to the
      canonical uppercase one on every surface — `assertValidEnvName("supabase_access_token")`
      returns `SUPABASE_ACCESS_TOKEN`, setting it twice in different cases updates ONE entry, and
      removing it by either spelling removes that entry; the reserved check runs on the folded name
      (`path`, `node_options` are still refused) and an invalid name still fails, quoting what was
      typed. The admin card upper-cases the name box on input and on blur and sends the folded name
      (automated: `test/channel-env.test.js`).
- [x] Name rules: `^[A-Z][A-Z0-9_]*$` only; the reserved set refuses everything `child-env.js`
      sets or allowlists plus the interpreter/linker hooks that turn a variable into code
      (`LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`, `BASH_ENV`, `PYTHONSTARTUP`,
      `PERL5OPT`, `GIT_SSH_COMMAND`, `GIT_EXTERNAL_DIFF`, `PAGER`) and the identity re-pointers
      (`ANTHROPIC_*`, `OPENAI_*`, `CLAUDE_*`, `CODEX_*`, `CG_*`, `SLACK_*`, `XDG_*`)
      (automated: `test/channel-env.test.js`).
- [x] Value rules: non-empty, no CR/LF/NUL (a pasted `.env` line or PEM is refused, not stored),
      16 KiB cap (automated).
- [x] Write-only: the listing shape carries name + provider + last4 + setBy + setAt and no value;
      a value under 12 characters gets NO tail; no Slack view (list or update form) contains a
      value; the update form is never pre-filled (automated).
- [x] Tolerant read / strict write: a hand-edited store drops lower-case names, reserved names,
      non-object entries and unknown providers rather than failing a run; the per-channel cap is
      enforced on ADD but a replace of an existing name is not an add (automated).
- [x] Injection: a resolved variable reaches the Claude and Codex child env; a hand-planted
      `HOME`/`PATH`/`LD_PRELOAD` in the same map cannot displace the gateway's own — enforced at
      the runner boundary (`safeSpawnEnv` inside `buildClaudeEnv`/`buildCodexEnv`), not merely by
      merge order, because `PATH` is inherited rather than set (automated).
- [x] Host-credential suppression: a channel that sets `SUPABASE_ACCESS_TOKEN` suppresses the
      `supabase` integration's shared saved login for that channel only, so it cannot silently
      fall back to the daemon's identity when its own token expires (automated).
- [x] Warm pool: the fingerprint tracks VALUES (a rotation retires the warm process, an unchanged
      secret does not) and is a digest, never the values themselves (automated).
- [x] Redaction: exact values are stripped from a turn's output, longest-match first; a value
      split across two deltas is still caught by the holdback redactor; with no secrets the
      redactor is a pass-through; the holdback is always released, so an answer never loses its
      tail (automated).
- [x] Admin card (ADM-009 regression): the env card saves through its OWN request, so typing a name
      or a value — or storing one — never raises the conversation card's "Unsaved changes" bar over
      edits that do not exist; all three dirty-trackers (conversation card, DM/template card,
      Settings page) exempt the same self-saving controls (automated: `test/channel-env.test.js`).
- [x] Slack discovery: every authored completed-run footer includes the 🔑 secrets manager control
      even when `channelSecretCount` is absent or zero, while author-less posts still expose no
      requester-bound controls (automated: `test/slack-progress.test.js`,
      `test/review-file-buttons.test.js`).
- [ ] Manual: `/secrets` in a Bash channel lists nothing, "Add or update" stores
      `SUPABASE_ACCESS_TOKEN`, the list then shows `••••<last4>` with who/when, and the same value
      cannot be retrieved from Slack, the admin UI, or `POST /api/secrets/reveal`.
- [ ] Manual: two channels hold different Supabase tokens; `supabase projects list` in each acts
      as that channel's account, and neither run can see the other's variable (`printenv` shows
      only its own).
- [ ] Manual: a bash channel that echoes its own token gets `[REDACTED]` in the posted reply, in
      the live stream, and in a `run_in_background` job's output.
- [ ] Manual: removing a variable in the Slack modal takes effect on the NEXT turn of an already
      warm thread (the fingerprint change retires the pooled process).
- [ ] Manual: a read-only channel's `/secrets` lists the names but offers no add/remove control;
      in an admin-mode channel a non-admin gets the same read-only view.

## Container runtime (v0.8 P1)

**Retired 2026-09-03 (Linux + containers only):** the container is the ONLY runtime. The entries
below that exercise the `host` backend, the kill switch, the per-channel pin and `runtimeEffective`,
`set_channel_runtime`, the host-side background card and the container→host half of the session carry describe
retired behaviour and are kept as history; everything else stands.

Unit coverage runs without a container binary on the machine: `test/container-fake-cli.js` is a
scripted stand-in for `podman`/`docker` that records every argv, and `test/runtime-fake.js` plus
`test/fixtures/fake-runtime-backend.js` are contract-validated fake backends that delegate the
actual spawn to the daemon-internal local runtime, so orchestration tests really run a turn. The LIVE checks below
are the v0.8 production deployment gate and are executed in the QA loop that follows this slice.

### Browser toolchain in the image (spec 1.3.0, 2026-09-07)

- [x] Unit: the Containerfile installs the pinned `playwright` and `agent-browser`, takes its
      distro dependency set from `playwright install --with-deps chromium` (never a hand-copied
      library list), and launches the browser once at BUILD time so a missing shared library fails
      the build (automated: `test/container-image.test.js`).
- [x] Unit: `PLAYWRIGHT_BROWSERS_PATH` and the stable chromium path agree with
      `src/runtimes/container/image-paths.js`; the browsers live under the root-owned bundle root
      and NOT in the per-channel HOME volume; `chmod -R a+rX` keeps them readable by the agent
      user; neither the Containerfile nor the image contract names a chromium revision (automated).
- [x] Unit: `AGENT_BROWSER_EXECUTABLE_PATH` is set in the image's FINAL `ENV` and points at that
      stable path, so every exec inherits it instead of the driver discovering an unmanaged
      download in the channel's volume (automated).
- [x] Unit: `PLAYWRIGHT_VERSION` and `AGENT_BROWSER_VERSION` are declared as ARGs and passed by
      `scripts/build-image.mjs`; both pins are exact (automated).
- [ ] Manual (host, after `npm run build:image`): in a fresh channel with no setup of its own,
      `agent-browser open https://example.com` succeeds and `agent-browser snapshot -i` returns the
      accessibility tree — the pre-fix failure was `error while loading shared libraries:
      libnspr4.so`. Repeat in a SECOND channel to prove it is the image and not one volume.
- [ ] Manual (host): `podman image inspect` reports `cg.image.version=1.3.0`, and a channel whose
      container predates the rebuild is recreated on its next run by the image-id fingerprint.

- [x] Unit: the backend contract fails closed — a missing declared capability, a missing method, an
      unknown capability key, and an unknown backend id each throw; `runtimeSupports()` reads a
      declared capability, accepts a target wrapper, and throws on an unknown KEY; the registry
      loads both backends and resolves an unknown or empty id to `host` (every pre-v0.8 record is a
      host record) (automated: `test/runtimes-core.test.js`).
- [x] **Retired 2026-09-03 (Linux + containers only):** every channel resolves to the container backend. Unit: precedence produces the exact `{backend, reason}` pair for every rung — kill switch →
      `disabled`, admin mode → `admin-mode`, a channel pin → `channel` in both directions, the
      gateway default → `default`, and an invalid pin falls back to `default`; `resolveRuntime()`
      builds the documented target (host: `artifactDir:null`, `container:null`, `cwd === workDir`,
      `fingerprint() === "host"`; clean mode swaps `cwd` to the clean workspace; container: the
      `.runtime/<platform>/<slug>` artifact dir and a container block) (automated).
- [x] **Retired 2026-09-03 (Linux + containers only):** Unit: the host backend is byte-for-byte today's behaviour against a real child — spawn tags
      the child, `probe` follows the pid true→false across a real SIGTERM, `signal` returns true,
      `resumeCommand` is a passthrough, `describe` is `{backend:"host", state:"host"}`, and
      `helperCommand` resolves to `process.execPath` + this checkout's script (automated).
- [x] Unit: run ids are a closed set (`newRunId("turn")` throws) and round-trip their kind, because
      the id doubles as the container-side process-group handle and the boot sweep's filter prefix
      (automated).
- [x] Unit: the CLI probe reports capabilities rather than branching on a binary name — rootless
      podman → `keep-id`, docker → `user`; `auto` tries podman then docker and, when both fail,
      names each failure with its remedy ("not installed", the socket permission-denied text +
      "join the `docker` group or install podman"); a docker CLI whose daemon never answers is
      `ok:false`; results are cached inside a TTL and `invalidate()` forces a re-probe (automated:
      `test/container-cli.test.js`).
- [x] Unit: a missing image is an actionable refusal naming `npm run build:image` and NEVER triggers
      a build inside a turn (no `build` verb reaches the CLI) (automated).
- [x] Unit: `buildCreateArgs` emits the exact hardening contract — `--userns=keep-id` on rootless
      podman vs `--user uid:gid` elsewhere, `--init`, `--security-opt no-new-privileges`,
      `--cap-drop ALL` plus only `DAC_OVERRIDE`/`CHOWN`/`FOWNER`, the single `/run` tmpfs (with
      `/tmp` and `/var/tmp` proven NOT to be tmpfs — see the durability cases below), the
      pids/memory/cpu caps, `--network bridge` (`none` for network-off), the label set including
      `cg.fingerprint`, `cg.mounts` and `cg.created`, and the trailing `<image> cg-init sleep infinity`; no
      secret ever appears on argv; when the cgroup probe failed, all three limit flags are dropped
      (automated).
- [x] Unit: `buildExecArgs` is `exec -i --env-file <f> -w <cwd> <name> cg-exec <runId> <cmd> …` and
      never `-e KEY=VALUE`; a detached job uses `exec -d`, wraps in `/bin/sh` and passes the log
      path as a positional so nothing needs quoting (automated).
- [x] Unit: the env file is 0600 under the channel's metadata folder, keeps quoted and spaced
      values, DROPS what a line-oriented file cannot represent and names the dropped keys in the
      log; host-only variables do not survive into the container, the backend owns
      `HOME`/`CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`CG_RUNTIME` (a host `CG_RUNTIME=host` is forced to
      `container`), and engine-computed values pass through untouched (automated).
- [x] Unit: the mount contract — the kinds are exactly workdir/clean/artifacts/home/socket/
      codex-auth; every bind source is absolute; nothing under `config/`, never `gateway.db`, never
      the gateway root itself, never the per-channel metadata folder; the socket mount is read-only;
      the Codex credential is a single file mount; and workdir/clean/artifacts have IDENTICAL source
      and target paths (automated: `test/container-lifecycle.test.js`).
- [x] Unit: the fingerprint covers create-time configuration only — a new image ID changes it, a
      network-mode change changes it, a per-exec meta change does not (automated).
- [x] Unit: the operator-home grant — an adminMode channel gets the `operator-home` bind (source =
      target = the daemon user's home, rw) plus a tmpfs `mask` over `~/.local/share/containers` ONLY
      while `fullAccessHome === true` (a Worker channel with the switch on, an admin channel with it
      off, and a truthy non-boolean all get nothing); the grant moves the fingerprint both ways
      (switch and mode); the create argv carries the home as a plain rw `-v` and the mask as
      `--tmpfs …:rw,noexec,nosuid,size=1m,notmpcopyup` (`notmpcopyup` is load-bearing: podman's default
      copies the destination's contents into the tmpfs, gigabytes of container store into 1 MB —
      proven live), and without the grant `/run` is the only tmpfs
      (automated: `test/container-lifecycle.test.js`).
- [x] Unit: Claude's ADMIN settings variant lists the operator home in
      `permissions.additionalDirectories` only when the resolved target mounts it (never the mask,
      never without a target); the shared variant never does (automated: `test/folders-settings.test.js`).
- [x] Unit: `PUT /api/settings` stores `containerFullAccessHome` as a boolean only (default false;
      a string is ignored, not stored), `settingsForApi` + `getContainerRuntime()` read it back, and
      the admin UI's Container runtime card carries the checkbox wired both ways (automated:
      `test/admin-container-runtime.test.js`).
- [x] Unit: the Container runtime card's copy matches the containers-only runtime — no "host
      sandbox" and no "admin-mode channels always stay on the host"; it says an admin-mode channel
      runs in its container with the permission bypass applied inside it (automated:
      `test/admin-container-runtime.test.js`).
- [x] Live (2026-09-06, throwaway container on the real image, rootless podman 5.7): the home bind +
      mask create args work; the `agent` user sees every channel folder and memory, every repo and the
      gateway logs, can write, and `~/.local/share/containers` is an empty tmpfs while the host store
      is untouched.
- [ ] Manual (production gateway, both engines): switch on → an admin author in a Full-access channel lists
      another channel's `MEMORY.md` under `~/ChannelGate/slack/<slug>/` and a repo under `~/Code/`
      with Read/Bash (Claude) and the shell (Codex); `podman inspect` shows the home bind + the
      tmpfs mask; a Worker channel's container shows neither; switch off → the admin container is
      recreated at its next turn without the mount.
- [x] Unit: the state machine — missing → create + start with the artifact dir made 0700 BEFORE the
      mount; exited → `start`, never a recreate, and a lost lease is announced in-thread; running
      with a matching fingerprint → reused with no CLI mutation at all; running with a stale
      fingerprint → recreated when unleased, with `rm -f` before the create and both fingerprint
      labels stamped on the new container (automated).
- [x] Unit: the MOUNT half of the fingerprint (`containerMountFingerprint`, label `cg.mounts`)
      covers the work dir, clean workspace, artifact dir, HOME volume and every bind/mask, and
      nothing about behaviour — a rebuilt image does not move it, a moved work folder and the
      operator-home grant do (automated: `test/container-lifecycle.test.js`).
- [x] Unit: a MOUNT-affecting mismatch is never deferred — idle → rebuilt before the turn is
      exec'd; busy → the turn waits on the reaper (initial notice plus minute reminders) and rebuilds
      when other occupants finish, including beyond the old deadline. Stop cancels polling or a
      queued preparation lock without `rm`, `run` or `start`. Multiple preparatory leases cannot
      deadlock the wait, and the rebuilt container retains their protection from idle eviction.
      An IMAGE-only mismatch while busy is still deferred with "recreating when it next goes idle"
      (automated: `test/container-lifecycle.test.js`).
- [x] Unit: `leaseCount(name, { exclude })` — a turn's own lease is not "someone else is inside"
      (run.js leases BEFORE ensureUp so the idle reaper cannot stop the environment mid-spawn, and
      counting it made every turn look busy to itself); a real background lease still counts, an id
      nobody holds subtracts nothing, and `acquireLease` hands back the id the exclusion is keyed on
      (automated: `test/container-reaper.test.js`).
- [x] Unit: `parseInspectLine` reads the tenth `cg.mounts` field, maps `<no value>` to empty, and
      still parses a nine-field line from a container created before the label existed — an unknown
      mount fingerprint counts as CHANGED, not as matching (automated).
- [ ] Manual (production gateway): point a channel's `workDir` at a subfolder, send a turn (the container is
      created with that folder bind-mounted), restore `workDir` to the default and delete the
      subfolder, then send another turn. Pass when the container is rebuilt before the turn runs
      and the answer arrives normally; fail on `Append system prompt file not found` or any reply
      produced inside the old container (the 2026-09-06 regression: three turns in a row).
- [x] Unit: a container carrying our name but a foreign or missing `cg.install` label is refused and
      never removed; a `paused` container fails closed; no usable CLI and no built image each reject
      with their own remedy text (automated).
- [x] Unit: an exec that hits "no such container" re-runs `ensureUp` and retries EXACTLY once, then
      succeeds; the boot reconcile filters on `label=cg.install=<id>`, sweeps only running
      containers of this install with `cg-sweep run warm` (detached job groups survive), and leaves
      an exited or foreign container alone (automated).
- [x] Unit: `destroy` always removes the container and removes the HOME volume ONLY with
      `volumes:true` — a rollback or a reconfiguration must not delete a channel's CLI logins
      (automated).
- [x] Unit: naming is install-scoped and collision-proof under clamping, both the container and its
      `-home` volume stay inside the length ceiling, and `isOurContainer` is true only for this
      install; podman/docker inspect-output differences (`configured` → `created`, a leading `/`,
      `<no value>`, both timestamp formats, four real "gone" strings) are parsed rather than
      guessed (automated).
- [x] Unit: the reaper counts LEASES, not quiet — a leased container is never stopped however long
      it is silent, `release()` restarts the idle clock and is idempotent, an unleased container
      past the window is STOPPED (not removed), and a stopped one is not stopped twice; the
      max-running cap stops the least-recently-used IDLE container, and with a fully leased fleet it
      waits, announces once, then refuses with "all N container slots are busy" rather than killing
      a running job; `startTimer()` is idempotent so a second boot cannot double-sweep (automated:
      `test/container-reaper.test.js`).
- [x] Unit: VS Code's attached-container URI hex-encodes the exact managed container name and opens
      the identical mounted workdir; a signed external editor lease survives the daemon/process
      boundary and a daemon restart, blocks idle stopping, cannot be confused with a reused PID, and disappears on
      release; the Claude wrapper consumes the refreshed operator/setup-token relay only when the
      gateway did not inject a credential; `code --wait` holds the lease and cleanup removes both
      the marker and live token even on failure (automated: `test/vscode-container.test.js`).
- [ ] LIVE (Claude): on a gateway host with VS Code + Dev Containers configured for Podman, run
      `npm run vscode -- cg-testing-claude-bash`; in the attached terminal verify the cwd is the
      channel's mounted workdir, `claude -p 'Reply with exactly VSCODE-CLAUDE-OK'` succeeds on the
      gateway operator's normal subscription, and `/api/health` keeps the container leased past its
      idle window. Close the window and verify the editor lease/token disappear.
- [ ] LIVE (Codex): repeat with `cg-testing-codex-bash`; verify `codex exec 'Reply with exactly
      VSCODE-CODEX-OK'` succeeds without another login, a marker written in `/home/agent` is visible
      to the next chat turn, and closing VS Code releases the editor lease without removing HOME.
- [x] Unit: credential modes and their remedies — a configured token is mode `token` with nothing
      copied or mounted; no token and no login anywhere is `missing`; a readable login settles to
      `relay` whether it is the OPERATOR's own `~/.claude` or one signed in to the gateway's engine
      home, with nothing copied or mounted either way; Codex resolves to `shared-file` or `missing`
      in candidate order.
      `credentialError()` returns null when the engine can run and otherwise names the exact remedy
      per engine — including when it is called BEFORE `ensureUp` has settled the target (automated:
      `test/container-credentials.test.js`).
- [x] Unit: `prepareTarget()` is pure and deterministic (no I/O, `imageId:""` until `ensureUp`
      settles it), and `ensureUp` then settles the image id/version, uid strategy, credential modes
      and mounts — with no Codex login there is NO `codex-auth` mount on the run argv, and a login
      that appears between two passes brings the mount back without duplicating it (automated).
- [x] Unit: `helperCommand()` returns image-bundle paths only and never a checkout path (the Stop
      hook, the Codex secret-env bridge, the remote-secret bridge, and the gateway MCP bridge —
      which Composio SDK mode reuses as a second service); an unknown helper throws; the returned
      object is a copy, so a caller cannot corrupt the table (automated).
- [x] Unit: spawn before `ensureUp` emits an `error` event on the child instead of throwing;
      probe/signal address the run by its runId (`cg-probe` / `cg-signal`), and probe semantics are
      three-valued — exit 0 alive, exit 1 dead, "no such container" dead, and a TIMEOUT still alive,
      because an inconclusive probe must not end a turn (automated).
- [x] Unit: the stop path is EXECUTED, not string-matched: `cg-exec` starts a run whose child
      escapes into its own session and process group (`setsid <cmd> &`, the shape Claude Code's
      Bash tool has), and `cg-signal` — pointed at a temp pidfile dir through `CG_RUN_DIR` — leaves
      neither the leader nor the escapee alive, with the escape asserted as a precondition so the
      test cannot pass vacuously; Linux-only (automated: `test/container-image.test.js`).
- [x] Unit: the image contract is asserted against the Containerfile and the build script rather
      than trusted — every `IMAGE_HELPERS` path is one the build actually stages; the bundle is the
      import closure of the three engine-spawned helpers and stays under a dozen modules with
      `settings.js`, `db/index.js`, `engines/registry.js` and `gateway/run.js` PROVABLY absent; the
      `mcp-remote` pin matches `package.json`; every version pin is exact and every build ARG is
      both declared and passed; the image bakes the declared `PATH`, `HOME` and npm prefix and
      pre-creates `/home/agent/.claude` and `/home/agent/.codex` owned by `agent` (so the Codex file
      mount cannot land in a root-owned directory); and all six container-side helper scripts exist,
      are executable, and pass `sh -n` (automated: `test/container-image.test.js`).
- [x] Unit: the built-in gateway video-understanding contract pins the OpenCV and faster-whisper versions,
      installs distro `ffmpeg`/`ffprobe`, preloads Whisper `small` under the shared read-only model
      cache, passes every pin through the image builder, and bumps the daemon/image spec in lockstep
      (automated: `test/container-image.test.js`).
- [x] Unit: `gateway-usage` materializes its video workflow, dependency reference, and analyzer
      script into every surface; the former standalone slug is rejected at the grant boundary,
      excluded from the catalog, removed from organization/template/channel/personal grants at
      boot, and stale gateway-managed workspace copies are pruned (automated:
      `test/access-grants.test.js`, `test/managed-write-symlinks.test.js`,
      `test/skills-platform.test.js`).
- [x] Unit: `npm run setup` builds the channel image as part of the install (`scripts/install.sh`
      runs `scripts/build-image.mjs`), accepts `--skip-image` / `CG_BUILD_IMAGE` to defer it, and
      names `npm run build:image` as the remedy when skipped or failed (automated:
      `test/container-image.test.js`).
- [x] Unit: durability — the mount contract keeps `/tmp` and `/var/tmp` as rw BIND mounts of
      `<artifactDir>/{tmp,var-tmp}` and leaves `/run` as the only tmpfs, and both appear on the
      create argv beside `--userns=keep-id` (rootless) / `--user uid:gid` (docker), so files in the
      volume and the binds are owned by the daemon user on both sides (automated:
      `test/container-durability.test.js`).
- [x] Unit: durability — nothing the gateway does routinely destroys state: the idle sweep and the
      max-running cap issue `stop` and never `rm`/`volume rm`/`volume prune`/`system prune`; a
      fingerprint mismatch recreates with `rm -f` + a `run` whose `-v` list carries the SAME HOME
      volume and the same two temp binds; `destroy(target)` never removes a volume and only
      `{volumes:true}` does; the boot reconcile issues no `rm`, `stop` or `volume` command at all
      (automated).
- [x] Unit: durability — a source scan of `src/` (comments excluded) proves NO production caller
      passes `volumes: true`, so the one switch that can delete a channel's logins and installs
      cannot be flipped by accident; the test names channel deletion as the only reason to change it
      (automated, in the style of the `runMessage` origin tripwire in
      `test/run-escalation.test.js`).
- [x] Unit: durability — a host `PATH`/`TMPDIR`/`NPM_CONFIG_PREFIX`/XDG value never reaches a
      container run (it would hide `~/.local/bin` and move future installs out of the volume), the
      backend owns `HOME`/`CLAUDE_CONFIG_DIR`/`CODEX_HOME`, and no container default names a path
      under the daemon's home (automated).
- [x] Unit: durability — the image PATH puts `~/.npm-global/bin`, `~/.local/bin`, `~/bin` and the
      `~/.cargo`/`~/.bun`/`~/.deno`/`~/go` bin dirs ahead of `/usr/bin`, every writable entry is
      inside the HOME volume, and the SAME string is declared in `containers/Containerfile`,
      `src/runtimes/container/image-paths.js` and the `src/engines/runtime-target.js` fallback (which
      had already drifted once); the image installs `python3-pip`/`python3-venv`/`pipx` with
      `PIP_USER=1`, `PIP_BREAK_SYSTEM_PACKAGES=1` and `PIPX_BIN_DIR` on PATH, pre-creates
      `~/.local/bin` and `~/bin` owned by `agent`, and `cg-init` recreates them on every start so a
      volume made before they existed gets them too; `containers/versions.json` `imageSpecVersion`
      equals the `IMAGE_SPEC_VERSION` the daemon expects (automated).
- [x] Unit: durability — boot logs `the built image is spec X but this checkout expects Y` with
      `npm run build:image` when the built image's label is older, and says nothing when it matches
      (automated).
- [ ] Live (opt-in, `npm run test:live-container`, needs podman/docker + a built image; skipped
      otherwise): on a throwaway `cg-durability-<random>` channel — create the container, write
      `~/.config/durability/marker`, `/tmp/…`, `/var/tmp/…` and an executable `~/.local/bin/cg-fake-cli`,
      prove `cg-fake-cli` RESOLVES on PATH and runs; `stop` it and bring it back up (started, not
      recreated) → all four still there; change a create-time-immutable field to force a recreate →
      a genuinely new container id, the same HOME volume in `inspect`, and all four still there;
      then `destroy(target, { volumes: true })` removes the throwaway (automated:
      `test/container-durability.live.test.js`).
- [ ] Live (same opt-in case): inside the real built image resolve `ffmpeg` and `ffprobe`, import
      OpenCV and faster-whisper, and instantiate Whisper `small` with Hugging Face forced offline,
      proving the model is pre-cached rather than downloaded on first use (automated:
      `test/container-durability.live.test.js`).
- [ ] Manual: in a real container channel, `npm i -g cowsay`, `pip install cowsay` and a `curl`
      installer each put a working command on PATH; leave a file in `/tmp`; wait past
      `containerIdleMinutes` (or stop the container by hand), send another message — every command
      still runs and the file is still there. `apt install` fails, and the reply says to ask the
      operator to bake it into the image.
- [x] Unit: the control socket is 0600 inside a 0700 directory and reports its state; a malformed,
      wrong-version or unknown-service hello is refused with one JSON error line and a close; a
      capability signed with another secret, absent, or expired is rejected; an over-long socket
      path returns null with a warning instead of failing the boot (automated:
      `test/mcp-socket-server.test.js`).
- [x] Unit: the reference stdio↔socket bridge carries a full MCP session — the complete toolset
      registers, a SIGNED `toolset:"memory-review"` reduces the surface to exactly
      `update_channel_memory` with nothing in the bridge's environment saying so, and
      `report_progress` appears only when the grant says so; a refused bearer exits 1, prints the
      reason on STDERR and writes NOTHING to stdout; tool bodies receive `threadKey` and `authorId`
      from the signed claims (no `CG_THREAD_KEY` anywhere in the process tree) and reach the
      daemon's own injected background/approval/restart handlers directly (automated).
- [x] Unit: an isolated target's settings have no `sandbox` key AT ALL (not disabled, not emptied)
      while a host run still gets one, and policy — `permissions.allow`,
      `disableBypassPermissionsMode`, memory-off, the MCP allowlist — is identical on both backends;
      the Stop hook comes from the backend for an isolated target and stays byte-identical on the
      host, so no warm-process fingerprint moves for a change that is about containers (automated:
      `test/runtime-integration-folders.test.js`).
- [x] Unit: `ensureChannelFolder` creates both bind-mount sources as 0700 directories; an isolated
      run's engine-facing artifacts all live under the mounted artifact dir, its engine homes are
      the IMAGE's, and the host-only plumbing (toolchain launcher dirs, credential symlink sets, the
      Codex skill overlay) is not built at all — while a host run's artifacts stay exactly where
      they were (automated).
- [x] Unit: an isolated Claude turn runs with the image's `HOME`/`CLAUDE_CONFIG_DIR`/`PATH`/`TMPDIR`,
      the gateway's OAuth token wins over a channel secret trying to set it (or `HOME`, or `PATH`),
      channel secrets still ride in, host-location variables are dropped, and with no token
      configured the variable is ABSENT rather than empty; the host env is byte-identical with and
      without a target and the container token never reaches it (automated:
      `test/engine-runtime-isolated.test.js`).
- [x] Unit: an isolated Codex turn states a sandbox MODE per write posture (`read-only` /
      `danger-full-access`, the `sandbox_mode=` twin on resume) and compiles NO `default_permissions`,
      no `permissions.*`, no `features.network_proxy` and no `sqlite_home`, while `--ignore-user-config`
      and the per-mode approval policy are unchanged; its MCP entries are composed from the backend's
      helper commands with `CG_FS_ROOT`/`CG_WORKSPACE_DIR`/`CHANNELGATE_DIR`/`PATH` absent; its
      answer file and secret bundle live under the artifact mount, nothing names a path under the
      gateway root, and the bundle is deleted when the turn ends (automated).
- [x] Unit: every isolated Codex turn that states a sandbox mode also states
      `features.use_legacy_landlock=true` (fresh and resume, read and write posture), and an admin
      bypass — which has no sandbox — states no mechanism. Codex's default bubblewrap cannot start
      under the container's `--cap-drop ALL` + no-new-privileges and failed every command, which
      left Read mode unable to read (automated: `test/codex-args.test.js`).
- [ ] LIVE: in a Read-mode Codex channel inside a container, a read command (`ls`, `cat`) succeeds
      and a write (`touch`) is refused with "Permission denied" — not `bwrap: Unexpected
      capabilities but not setuid` on everything. Re-run after any Codex CLI bump: the Landlock
      feature flag is deprecated-but-functional in the pinned version.
- [x] Unit: the runner seam — a cold turn is spawned BY THE BACKEND with the contract spec
      (`stdio`, `detached`, `kind`, a `run-` id); a probe that THROWS is reported as a quiet event
      and never ends the turn; a definite `false` ends it and the kill goes back through the backend
      by run id; an abort signals the backend, not a host pid; a warm session uses a `warm-` id (the
      sweep's prefix) and still steers over stdin; and the warm pool treats WHERE a process runs as
      part of launch identity, so a new image fingerprint forces a new session and a host target
      never reuses a container's warm process (automated: `test/engine-runtime-seam.test.js`).
- [x] Unit: an isolated turn calls `ensureUp` exactly once, takes its `run` lease BEFORE warming and
      releases it at the end (including when the runtime fails to start), a runtime that cannot
      start rejects the turn before the engine runs, and a missing engine credential fails closed
      before `ensureUp` or spawn, flagged `details.runtimeCredential` and NOT as a provider error —
      so cross-engine failover cannot mask it (automated: `test/runtime-integration-run.test.js`).
- [x] Unit: a per-run mode override cannot move a turn between backends (the decision reads the
      channel's own `adminMode`/`runtime`); `runArtifactRoot()` returns the artifact dir for an
      isolated target and the run-tmp dir for a host or absent one; the session row and the
      `run_config` event both record where the turn ran; and a slow cold start emits exactly one
      "Warming up" notice while a fast one emits none (automated).
- [x] Unit: the container job wrapper redirects into the artifact-mounted log, escapes a log path
      containing a quote, and appends `[cg-exit:N]` — parsed back as the real code, as `null` for
      "unknown" when the marker is absent (never 0), and stripped before anyone reads the tail; an
      isolated job holds a `job` lease while running, crosses the seam detached with a `job-` id,
      and records `{backend, runId, container}` on its row (automated:
      `test/runtime-integration-jobs.test.js`).
- [x] Unit: a recovered container job is probed THROUGH THE BACKEND on its recorded runId, never by
      the stale client pid; one the backend reports gone is finished rather than signalled; a host
      job is unchanged (automated).
- [x] Unit: the user-facing surfaces — `formatRuntimeLine` is one word on the host and carries
      container name, image, state and uptime otherwise; the footer appends the image ref only for a
      container turn; `/resume` keeps the exact host form and uses the backend's exec form for a
      container, with no redundant `cd`; the heartbeat suffix is derived from the declared
      capability and a source-level guard forbids a `backend === "container"` comparison in the
      progress layer (automated: `test/runtime-integration-surfaces.test.js`).
- [x] Unit: migration 13 is additive — the column exists, a legacy row reads as host without
      throwing, the stamp round-trips, `/clear` wipes it, and GARBAGE in the column returns null
      instead of crashing; a container session's recorded cwd still passes the same-channel
      `/resume` adoption rule because the mount path is identical; and a memory review runs through
      the backend (`ensureUp`, a `review` lease taken and released, its config under the mount)
      (automated).
- [x] Unit: session carry-over — the per-engine facts say where a session lives (Claude keys
      `projects/<key>` off the RUN's cwd so clean mode keys the directory it ran in, and carries the
      `<id>/` subagent directory too; Codex's rollout is a PATTERN because its filename carries a
      timestamp nobody can recompute; OpenCode declares none and is skipped); an adapter that
      half-declares `sessionState` does not load; the state dir comes from the target, never a
      literal (automated: `test/session-carry.test.js`).
- [x] Unit: the host-side copy expands a wildcard on the SOURCE side and lands the matched tail
      under the destination, so a Codex rollout keeps its YYYY/MM/DD directories; the rule is
      overwrite-and-merge with no delete — a same-named file is replaced, a file the destination has
      and the source does not survives, the source is never touched, and a missing source is 0
      copied rather than an error (automated).
- [x] Unit: the orchestrator carries only when the backend actually CHANGED — same backend on both
      sides is a no-op (a recreated container still has its volume), an empty/malformed/pre-migration
      stamp reads as host, host→container calls `copyIn` and container→host calls `copyOut` on the
      CONTAINER side in both cases, a `run` lease is held around the whole copy and released, and a
      backend that throws, an engine with no fact, and a backend that cannot carry each log one line
      and hand back to the existing heal without failing the turn (automated).
- [x] Unit: the container half stages under the bind-mounted artifact dir mirroring the DESTINATION
      path and runs exactly ONE `/bin/sh -c` inside (never `cg-exec`, never one exec per file); the
      generated scripts are EXECUTED by a real `/bin/sh` in the test, proving `cp -a src/. dst/`
      merges instead of nesting, that a guarded source is skipped, and that a wildcard is expanded
      by the shell on the side that owns the files; the staging directory is removed on success AND
      on a failed exec; a file the container stages OUTSIDE the requested state dirs is refused with
      a log line rather than written (automated: `test/container-carry.test.js`).
- [x] **Retired 2026-09-03 (Linux + containers only):** Unit: boot starts the idle reaper even with the gateway kill switch OFF (a carry may bring one
      container up to read its HOME volume, and nothing else would stop it again), and the reaper is
      inert until that happens (automated: `test/container-carry.test.js`).
- [x] Unit: the contract declares `copyIn`/`copyOut`/`credentialError` as OPTIONAL and still fails
      closed — absent is fine, present-but-not-a-function does not load; `runtimeCanCarry()` needs
      both halves; and `resolveRuntime(..., { backend })` is the one way to address a channel's OTHER
      environment (reason `override`), while an unknown id leaves the channel's own precedence
      standing (automated: `test/runtimes-core.test.js`).
- [x] Unit: at the turn level the carry runs BEFORE the resume in both directions, the files really
      arrive in the other runtime's state dir (subagent transcripts included), the session row is
      re-stamped so a later turn cannot carry a stale copy back over the newer one, `run_config`
      carries `sessionCarried` only when a carry happened, and a carry that throws still answers the
      turn; a carry slow enough to feel (a cold container start, before the turn's own warm-up notice
      is armed) emits exactly one gateway notice (automated:
      `test/runtime-integration-run.test.js`).
- [x] Unit: the admin boundary refuses rather than sanitizes — an unknown backend, an unlisted CLI,
      a flag or a shell metacharacter smuggled into the image/memory/cpu values, and out-of-range
      idle/max/pids each return 400 and write NOTHING partial; blank memory/cpus/image mean "no
      limit" and the default image; the Claude container token is write-only (`has*`/`last4` in
      listings, revealable only through the named-getter allowlist, preserved by an unrelated save,
      cleared on request); the per-channel and per-DM `runtime` values are validated identically and
      listings carry `runtimeEffective` beside the pin, flipped by the kill switch and by admin mode
      while PRESERVING the stored pin; and `/api/health` omits `containerRuntime` for an
      unauthenticated caller and degrades a throwing status reader to a reason inside a 200
      (automated: `test/admin-container-runtime.test.js`).

- [ ] Live: **cold start budget** — the first message in a containerized channel answers within
      +2 s of the same channel on the host (container create/start plus engine boot), and the
      "Warming up this channel's container" notice appears only when it is actually slower than two
      seconds.
- [ ] Live: **warm parity** — a follow-up in the same thread is as fast as the host backend's warm
      follow-up, and the reply retains the thread's context.
- [ ] Live: **the live UX crosses the exec boundary** — streaming deltas, the tool timeline, the
      heartbeat row (with its ` · container` suffix), the queue position, a stop word and an
      in-flight steer all behave as they do on the host.
- [ ] Live: **both Composio identities work** — `composio-user` lists the author's tools and
      `composio-agent` lists the channel/organization account's, in SDK mode as well as
      Personal mode (SDK rides the same socket as a second service).
- [ ] Live: **gateway tools over the socket** — a schedule, a channel-admin change, a
      `report_progress` call and an approval prompt all work from inside a container; the run holds
      no `CG_APPROVAL_SECRET` or `CG_PORT`; and no container in `podman inspect` mounts the gateway
      root, `config/`, `gateway.db` or the channel metadata folder.
- [ ] Live: **memory review runs in the container** — a turn worth remembering produces the
      post-reply reviewer inside the channel's container, it saves what the model did not, and it
      announces the save in the thread.
- [ ] Live: **file visibility and ownership both ways** — a file the agent creates in the channel
      workdir appears instantly in host VS Code owned by the daemon user, and a file created on the
      host is readable and writable in the next turn (`--userns=keep-id` parity).
- [ ] Live: **a CLI login survives a reap** — `supabase login` (or `gh auth login`) inside the
      channel, then let the idle reaper stop the container, then send a new message: the login is
      still there because it lives in the per-channel HOME volume. Repeat across a container
      RECREATION (bump the image) — the volume is untouched.
- [ ] Live: **a repo channel keeps the worktree discipline** — create a branch and a worktree,
      commit, and push with the channel's own `GH_TOKEN` (or a HOME-volume `gh` login) from inside
      the container; the identical-path mount keeps every absolute path the model prints valid on
      the host.
- [ ] Live: **Codex in a container, and honest failover** — a Codex turn answers using the shared
      sign-in file mount; a Claude turn that hits a provider outage fails over to Codex in the same
      container; and a turn on a user-PINNED harness fails with that harness's own error plus the
      manual-switch hint instead of being answered by the other engine.
- [ ] Live: **the idle reaper and a scheduled cold start** — an idle channel's container stops after
      `containerIdleMinutes`, and a scheduled run then cold-starts it and answers in the thread.
- [ ] Live: **a background job holds the container** — approve a shell job that runs past the idle
      window: the container is not stopped while it runs, the job's output is tailed live, its real
      exit code is reported, and the job survives a daemon restart (it is re-found by its runId, not
      by a pid).
- [ ] **Retired 2026-09-03 (Linux + containers only):** Live: **kill switch round trip** — with a channel pinned to `container`, switch
      Settings → Container runtime off: the next turn runs on the host, `/status` says
      `host` with the kill-switch reason, the pin is still stored, and the thread's session RESUMES
      across the switch. Switch it back on and the same thread resumes in the container.
- [ ] **Retired 2026-09-03 (Linux + containers only):** Live: **the conversation survives a backend change, not just the thread** — in a host channel
      have a Claude turn do real work (a compaction, a subagent, several tool calls), then flip the
      channel to `container` and continue the SAME thread with a question only the engine-native
      history can answer ("what did the subagent report?"). It answers without a heal, the log says
      `carried claude session … host→container (N files)`, and the `run_config` event carries
      `sessionCarried`. Flip the channel back to `host` (or to admin mode) and repeat in the other
      direction. Then do both again on Codex, checking that the rollout arrives with its
      `sessions/YYYY/MM/DD` path intact and `codex exec resume` finds it.
- [ ] **Retired 2026-09-03 (Linux + containers only):** Live: **a carry never breaks a turn** — with the container CLI stopped, send a message in a
      thread whose row still names the container: the turn answers (healed, as before), the log says
      `session carry-over failed (…) — the resume falls back to the existing heal`, and nothing under
      `~/ChannelGate/.runtime/<platform>/<slug>/carry/` is left behind.
- [ ] Live: **credential chain health** — with no `claude setup-token` configured, a container turn
      still answers using the copied login and the copy is adopted once (a second turn does not
      re-seed and does not roll the token back); with a token configured, no credential file is
      copied or mounted at all; with neither, the turn ends with the setup-token remedy and does NOT
      fail over to Codex. Sign Codex out on the host and confirm a Codex turn ends with the
      `codex login` remedy; sign back in and confirm a running container reports the inode change
      rather than a silently stale login.
- [ ] Live: **channel isolation inside the containers** — from channel A's container, prove that
      channel B's transcripts, prompt history and Codex sessions are unreachable (the HOME volume is
      per channel), and that neither container can read the gateway root or another channel's
      workdir.
- [ ] Live: **image rebuild retires containers cleanly** — `npm run build:image` after a pin bump;
      running channels keep answering, and each one's next turn recreates its container on the new
      image (the footer shows the new image ref) without losing its HOME volume.
- [x] Unit (`container-image.test.js`): `needsImageBuild()` is the pure rebuild decision — it builds
      when the candidate bumped `imageSpecVersion`, when a changed path is under `containers/`, or
      when no image is built at all; it does NOT build for an unrelated code change, and never at
      all with the container runtime switched off. Forward-slash normalisation and the shared
      default image ref (settings vs. `build:image`'s tag) are pinned with it.
- [x] Unit (`update-runner.test.js`): the update's channel-image step sits after provisioning and
      before the restart; it reads the built spec from the image's `cg.image.version` label and the
      expected spec from the CANDIDATE checkout's `containers/versions.json` (never the constant the
      runner imported before `git merge` moved the tree); a host-only install does not even probe
      the container CLI; and a build that FAILS — or throws — reports
      `run \`npm run build:image\`` and still restarts and verifies, with the transaction result
      `updated` rather than a rollback.
- [ ] Live: **`/update` picks the image up** — on a container-runtime host, land a commit that bumps
      `containers/versions.json` and run `/update`. The dashboard shows the *rebuilding the channel
      container image* phase, the update log names the new image id, the daemon comes back on the
      candidate revision, and the boot line no longer says `the built image is spec X but this
      checkout expects Y`. Repeat with the container CLI stopped: the update reports the build
      failure with the `npm run build:image` remedy and still completes.
- [x] **Retired 2026-09-03 (Linux + containers only):** the HOST-channel wording; the container card stands. Unit (`runtime-integration-jobs.test.js`): the background-shell approval card describes the
      environment the job will actually run in — a HOST channel keeps
      `Background shell job (unsandboxed)` / `Runs OUTSIDE the engine sandbox as the daemon user`,
      while a container channel's card reads
      `Background shell job (in this channel's container)` / `Runs inside this channel's container
      (<image>)`, names the image, and says neither "unsandboxed" nor "as the daemon user". Both
      still require an admin-tier click, and the Deny refusal follows the same wording.

### Skills platform (Core) — local catalog, profiles, templates, sources, authoring, usage

- [x] Unit: the frontmatter reader handles quoted/folded scalars, block and inline lists, nested
      maps, comments and `dependencies`/`requires` aliases, keeps the body verbatim and never
      throws; the file-bundle rules refuse traversal/absolute/backslash/reserved paths and
      duplicates, require a `SKILL.md`, classify text vs binary, and hash order-independently
      (`test/skills-platform.test.js`).
- [x] Unit: the catalog stores lossless revisions, dedupes by content hash, indexes the
      frontmatter (unmodelled keys survive in `meta`), refuses cross-owner writes as conflicts,
      stages revisions until approved, pins/rolls back, tombstones on source removal and restores a
      returning skill without a new revision; removing a source tombstones its skills
      (`test/skills-platform.test.js`).
- [x] Unit: an admin's exclusion is sticky — a re-put of the same or new bytes (what a sync does)
      and a host-folder re-import keep the skill out while still recording revisions; a plain
      source drop still comes back; restore clears both and lands on the newest revision; stats
      count exclusions apart from removals (`test/skills-platform.test.js`, admin API DELETE in
      `test/skills-admin-api.test.js`).
- [x] Unit: repository sections — a synced path `channels/<id>/…` and a local skill created
      with `channelId` carry `channelScope`; the channel tier includes the channel's section
      (`channelSkillGrants`); publishing a scoped skill writes `channels/<id>/<slug>/` plus the
      section README and a publish-repository skill goes back to its synced folder; `moveSkillScope`
      moves files, keeps the former channel as an explicit grant on promotion, and refuses skills of
      other sources (`test/skills-standalone.test.js`, `test/skills-templates-assign.test.js`, admin
      API `/scope` in `test/skills-admin-api.test.js`).
- [x] Unit: the profile resolver pulls `requires` dependencies, reports unknown names, missing
      dependencies and cycles, estimates always-on context and warns above the soft cap
      (`test/skills-platform.test.js`).
- [x] Integration: `enableSkills` materializes real files from the catalog write-on-change
      (manifest-guarded; nested references, executable scripts), keeps a project-owned folder,
      replaces a Skills Manager stub, rewrites on a new revision dropping stale files, prunes only
      managed copies when a grant ends, reports a staged-only skill as missing, and still copies a
      host-folder skill the catalog does not know (`test/skills-platform.test.js`,
      `test/folders-skills.test.js`).
- [x] Integration: host-folder import keeps directory names as slugs (case kept), follows the
      operator's symlinks, excludes nested skills, tombstones vanished folders and restores
      returning ones; the bundled starter library imports once as `bundled`
      (`test/skills-platform.test.js`).
- [x] Integration: git sync parses plain/ssh/tree URLs, resolves a branch containing `/` against
      the branch list, reads a synthetic tarball (own tar reader), discovers nested skills with
      correct file ownership and executable bits, skips a manifest without name/description,
      stages in review mode and activates in auto mode, tombstones upstream removals keeping
      revisions, records a failing GitHub call without discarding last-good state, honours a
      commit pin, and reports a slug held by another owner as a conflict
      (`test/skills-platform.test.js`).
- [x] Integration: scheduled/manual Git sync reads only the selected source row's optional token;
      it does not reuse the publishing or legacy global credential (`test/skills-platform.test.js`).
- [x] Integration: templates seed once, resolve explicit slugs,
      preview with dependencies, and are FOLLOWED live: assigning stores only the template slug on
      the conversation, the channel tier is template + own additions, a template edit reaches the
      follower, clearing keeps the additions, DM templates carry a template through `effectiveMeta`,
      the channel PUT resolves a template name and refuses an unknown one (400), and the profile
      endpoints expose the assignment (`test/skills-templates-assign.test.js`,
      `test/skills-platform.test.js`, `test/skills-admin-api.test.js`).
- [x] Integration: the usage recorder records Claude's `Skill` tool as exact and a `SKILL.md` read
      (path, target or shell command) as inferred, dedupes per run, `toolTarget("Skill")` names the
      skill, and the report lists never-used grants, off-catalog names and per-conversation rollups
      (`test/skills-platform.test.js`).
- [x] Integration (SKL-14 regression): Claude's plugin-qualified skill name
      (`gateway-shared-skills:<slug>`) attributes to the catalog skill — the prefix is stripped
      before the lookup, so the row carries the catalog slug with its skill and revision ids and the
      report marks it `inCatalog` with an exact signal; a plugin skill outside the catalog still
      records under its bare slug (`test/skills-platform.test.js`).
- [x] Integration (SKL-11 regression): ONE compound Codex shell line that reads two `SKILL.md`
      files — the always-on guide and the granted skill, mapped through `progressFromCodexEvent`
      exactly as the engine emits it — records BOTH skills, not just the first match, each as an
      inferred row carrying its catalog skill and effective revision ids
      (`test/skills-platform.test.js`).
- [x] Unit: the inferred-read matcher catches a `SKILL.md` read through either skills directory
      (`.claude/skills` or the `.agents/skills` symlink), absolute, relative, `~`-relative, quoted,
      repeated, or anywhere inside a compound command, deduped per text, and refuses a look-alike
      path such as `myskills/<slug>/SKILL.md` (`test/skills-platform.test.js`).
- [x] Integration: granting reports what it costs to whoever granted it — the admin API's
      `/skills/profile/:channel/grant` answers with `contextTokens` and `warnings` resolved over the
      conversation's whole durable tier (empty under the cap, carrying "always-on skill descriptions
      cost about N tokens per turn (soft cap M)" over it), and the `add_channel_skills` chat verb
      appends the same warnings to its reply (`test/skills-admin-api.test.js`,
      `test/skills-platform.test.js`).
- [x] Integration: authoring creates a local skill granted here, refuses an
      existing slug, merges partial files on update, refuses in-place edits of source-owned skills,
      files proposals, approves a change into a pinned override that survives the next source
      revision, rejects with a note, promotes organization-wide, and revokes by name or slug
      (`test/skills-platform.test.js`).
- [x] Integration: a grant stores only what was granted — a `requires:` dependency is reported to
      the caller but never written into `channel_meta.skills`, a user's tier or the organization
      tier (chat verbs, admin API `/skills/profile/:channel/grant`, and a newly authored skill's
      automatic grant); the profile and the usage report still attribute it as `via: "dependency"`
      / `requiredBy`, materialization still writes it, revoking a dependency reports the skill that
      keeps it active instead of a removal, revoking the parent takes the dependency with it
      (folder pruned, nothing stranded), and a dependency granted explicitly outlives its parent
      (`test/skills-platform.test.js`, `test/skills-standalone.test.js`,
      `test/skills-admin-api.test.js`).
- [x] Admin API: catalog create/read/file/update/pin/remove/restore, path rejection (400), a folder
      source imported in review mode → staged → approved, source validation/duplicates (400/409),
      mode/enable updates, removal tombstoning, template preview/apply, grant/revoke per
      conversation, profile and usage endpoints, proposals approve/reject, and the settings fields
      (clamps 400; the publishing token never rides a listing and is revealable only via the allowlist)
      (`test/skills-admin-api.test.js`).
- [x] Unit + Admin API (SKL-07 regression): a skill pinned to an older revision advertises THAT
      revision's name, description, category, tags, requires and version wherever the catalog is
      read — the derived index columns follow the pin exactly as the file list already did — and
      unpinning goes back to the current revision (`test/skills-platform.test.js`,
      `test/skills-admin-api.test.js`).
- [x] Unit (SKL-04 regression): a template preview reports the always-on context cost in labelled
      numbers — this tier, the organization tier that loads in every conversation whatever the
      template says, and the effective union (dependencies included, a skill in both tiers counted
      once) — instead of the template tier alone (`test/skills-platform.test.js`).
- [x] Drift tripwires: every skills tool is classified gated/open in the control-plane inventory
      (`test/mcp-control-plane-approval.test.js`) and present in the lockdown allowlist
      (`test/folders-settings.test.js`); the Skills admin view has a canonical path
      (`test/admin-navigation.test.js`).
- [x] Admin UI: Sources, Sync settings and MCP are separate tabs; adding a source is modal with
      only GitHub / Other ChannelGate choices and reveals only kind-relevant fields; GitHub branch
      and subfolder controls are absent (main is fixed and a subfolder belongs in the URL);
      templates are selection-first with searchable explicit-skill controls; Usage is
      searchable and usage-descending with By skill / By channel rollups, compact bars,
      and context-warning explanations. The profile API supplies warning text rather
      than only a count (`test/skills-admin-ui.test.js`, `test/skills-admin-api.test.js`).
- [x] Admin UI + API: Catalog keeps Owner, Category and Source filters alongside independent
      Enabled, Discoverable, Mandatory and Assigned tri-state filters (Enabled replaces show-removed).
      The API fixture toggles `governed-skill` through discoverability, mandatory and disabled
      states, then grants it to one conversation; each positive and negative query proves the row
      is included or excluded, and Disabled includes normally hidden catalog rows
      (`test/skills-admin-ui.test.js`, `test/skills-admin-api.test.js`).
- [x] Browser filtering regression: given the unfiltered API-shaped rows from the reported live
      failure, selecting Mandatory leaves only the mandatory row; Enabled and Discoverable enforce
      both sides; Assigned includes organization, explicit, template and channel-section grants but
      not a transitive dependency. The client fetches deleted rows explicitly, then enforces the
      selected state even while an older daemon process is still serving the API
      (`test/skills-catalog-filters.test.js`).
- [x] Source management browser acceptance (engine-independent: browser → admin REST API, no
      engine invocation): `test/skills-source-browser.test.js` starts an ephemeral Express/admin
      router with disposable folder sources Alpha (`alpha-active`, `alpha-disabled`) and Beta
      (`beta-only`). Disable `alpha-disabled` during setup. In Chromium, open Sources → Alpha;
      require both Alpha rows and no Beta row. Enable the disabled skill, turn discovery off on
      `alpha-active`, then make it Mandatory; require discovery to turn on and become locked.
      Reload, reopen Alpha, and require saved states. Search for `disabled` → one matching row.
      Select Beta in Catalog's Source dropdown → only `beta-only`. At 390 px, source cards must
      fit without page overflow. Require zero browser exceptions and successful API writes.
      Run with `CG_BROWSER_MODULE=/absolute/path/to/playwright/index.mjs node --test
      test/skills-source-browser.test.js` using an existing Playwright Chromium installation.
      Executed successfully with real Chromium against the disposable API; desktop screenshots
      inspected. The test skips by default when the optional browser driver is absent.
- [x] Admin UI (SKL-13 regression): every class the admin JS hides by setting `.hidden` carries a
      `[hidden] { display: none }` companion rule — an author `display` declaration beats the UA
      sheet's `[hidden]` whatever the specificity, so without it the template skill search filtered
      nothing and the Add-source dialog showed the GitHub and ChannelGate fields at once
      (`test/skills-admin-ui.test.js`).
- [x] Admin UI: the Usage panel renders the report's `notes` as a help line under the header (how a
      use is detected, exact vs inferred, capture is not retroactive) — one total per skill, no
      exact/inferred columns — and a grant's confirmation message carries the warnings the grant
      answered with (`test/skills-admin-ui.test.js`).
- [ ] Live (Claude + Codex): grant a catalog skill to a private test channel, ask for something its
      description covers, and confirm the skill fires from the materialized folder with no Skills
      Manager token configured (Claude: exact usage row; Codex: inferred row after it reads
      `SKILL.md`); `show_channel_skills` shows the tier and context cost.
- [ ] Live: add a public GitHub source in review mode from the admin UI, see its skills staged,
      approve one, apply the Development template to a channel and verify the next message
      materializes the approved skill; switch the source to auto and re-sync (unchanged).
- [ ] Live: `create_skill` from a channel as a non-admin approved member (approval card), then
      `propose_skill_change` on a synced skill and approve it in the admin UI → pinned override;
      `skill_usage_report` after a few turns lists the never-used grants.
- [x] Unit (SKL-02 regression): no shipped doc claims auto mode skips a control-plane skills
      approval. `docs/SKILLS.md` and the guide's `references/skills.md` state that
      `add_channel_skills` / `remove_channel_skills` / `set_channel_skill_template` ALWAYS post an
      Approve/Deny card and block for a click (auto-approval covers tool permissions only), the
      reads are described as open, and the retired "unless the conversation is in auto mode"
      phrasing cannot come back in either file or in `references/administration.md`
      (`test/approvals-layer.test.js`, behaviour proven in the same file and
      `test/mcp-control-plane-approval.test.js`).

### Skills platform (round two) — personal skills, publishing, webhook, MCP endpoint, peers, migration

- [x] Unit: the Skills Manager integration is gone from source (no `makeitfuture-skills` server, no
      skills tokens in identity resolution, MCP config, Codex argv, secrets allowlist or user/channel
      defaults); leftover stub folders are pruned on workspace configure while real skill folders
      survive; the lockdown carries no Skills Manager URL (`test/managed-write-symlinks.test.js`,
      `test/mcp-config.test.js`, `test/codex-args.test.js`, `test/access-grants.test.js`,
      `test/store-patch.test.js`, `test/folders-settings.test.js`, `test/settings-env-lifecycle.test.js`).
- [x] Integration: a personal skill is listed and grantable only to its author (admin surfaces see
      it), is granted to the author's own tier on creation and never published; feedback proposals
      need a note and close without a revision; an approved promotion turns it into an organization
      skill (`test/skills-standalone.test.js`).
- [x] Integration: user-tier and organization-tier grant/revoke resolve names to slugs and pull
      dependencies; `deleteOwnSkill` refuses another author and a synced skill
      (`test/skills-standalone.test.js`).
- [x] Unit: compatibility declarations report engine/platform/version/MCP mismatches as notes and
      never stop a skill from resolving (`test/skills-standalone.test.js`).
- [x] Unit: access tokens are minted once (`cgs_` prefix), listed by prefix only, verified by hash,
      scoped, and stop working on revocation (`test/skills-standalone.test.js`).
- [x] Integration (mocked GitHub Contents API): publishing writes every file of a revision under
      `<folder>/<slug>/`, deletes files a newer revision dropped, records the commit on the revision,
      and adopts the skill into a git source that points at the publish repository; missing token or
      repository reports instead of throwing (`test/skills-standalone.test.js`).
- [x] Integration (real HTTP): `/mcp/skills` refuses without a valid token (401) and GET (405),
      honours scopes (`propose`/`sync` denied to a read token), serves `library_search_skills` with
      facets, `library_get_skill_info`/`library_get_skill_file`, files proposals and creates skills
      with the right scopes, and exports manifests/files for peers — personal skills never appear
      (`test/skills-standalone.test.js`).
- [x] Integration (real HTTP): the GitHub webhook answers 404 until a secret is set, 401 on a bad
      signature, triggers a sync for the matching source on a valid push, and pongs a ping
      (`test/skills-standalone.test.js`).
- [x] Integration: a gateway source pulls a peer's manifest + files over the export tools, stages
      in review mode, activates the same bytes in auto mode without a new revision, tombstones what
      the peer dropped, keeps last-good on failure, refuses to run without a token, and never
      returns its secret on an API response (`test/skills-standalone.test.js`).
- [x] Admin API: tokens (value only on creation), visibility switch (400 on a bad value),
      organization grant/revoke, gateway sources with a write-only secret (+ clear), publish and
      webhook settings with validation (`test/skills-standalone.test.js`).
- [x] Drift tripwires updated for the new verbs (gated: delete/publish/org/source/exclude; open:
      reads and the member's own tier) (`test/mcp-control-plane-approval.test.js`,
      `test/folders-settings.test.js`).
- [ ] Live: run `scripts/migrate-skills-manager.mjs --dry-run` then for real on the production
      gateway; confirm every Skills Manager repository is a synced source, the organization tier and
      the two personal tiers carry the former favorites, and a channel's next message materializes
      them without any Skills Manager token.
- [ ] Live: add `/mcp/skills` with a read token to a laptop Claude Code (`claude mcp add --transport
      http …`), search and read a skill; revoke the token and confirm 401.
- [ ] Live: configure the publish repository = the private skills repository (also a source),
      create a skill from chat, confirm the commit lands and the skill shows as owned by that source
      after the next sync; push a change to a source repository with the webhook configured and
      confirm the sync runs within seconds.
- [ ] Live (two gateways): mint a `sync` token on the primary gateway, add it as a gateway source on the
      second gateway in review mode, approve a staged skill there, and use it in one of that gateway's channels.

## Security checks
- [ ] **Retired 2026-09-03 (Linux + containers only):** the sandbox wording — inside the container `~/.ssh` and sibling channel folders do not exist at
      all; the check itself stands. **Filesystem confinement:** inside a channel folder, `claude` cannot read/write outside it
      (attempt to read `~/.ssh` or a sibling channel folder is blocked by the sandbox).
- [ ] **MCP allowlist:** `claude mcp list` inside a channel folder shows ONLY the channel's
      allowed servers + the injected personal/shared Composio identities (per the run); nothing else.
- [ ] **Memory off:** no writes to `~/.claude/projects/<cwd>/memory/` for channel folders.
- [ ] **Composio isolation:** user A's `composio-user` token is never used for user B; shared
      `composio-agent` remains distinct; no tokens are written to channel `settings.json` or logs.
- [ ] **Dangerous perms:** `--dangerously-skip-permissions` only ever passed for admin authors.
- [ ] **Retired 2026-09-03 (Linux + containers only):** admin channels run in containers too; the admin author's live turn keeps only the bypass flag and
      its work folder mount. **Admin sandbox-off:** in an admin-mode channel, an admin's LIVE foreground turn can read a
      file outside the channel folder (e.g. `~/.config/...`) — the admin settings variant has
      `sandbox.enabled: false`; the shared variant keeps `enabled: true` and a non-admin (or any
      background/schedule/continuation run) still cannot read outside the folder.
- [ ] **Background gating:** `run_in_background` is refused in a plain `allowBash` channel. Auto mode
      requires a gateway admin's durable exact-command approval; Admin mode skips the second card
      only for an admin author. Restart/replayed clicks cannot reuse Auto-mode authorization.
- [ ] **Internal IPC:** `POST /internal/background` returns 403 without the per-process secret.
- [ ] **Secrets:** `.env` and `~/.channelgate/config/users.json` are gitignored; tokens never
      appear in logs or Slack messages.
- [x] Automated (OPS-04 regression): a channel meta row that still carries a RETIRED integration's
      token (`skillsToken`) is served by no channel read — the key is absent from `GET /api/channels`
      and `GET /api/dms`, and the value appears nowhere in either response body; `GET /api/users`
      never emits it either (its listing is an allowlist, not a spread). The DM listing masks the
      Make toolbox key too, which its own drifted copy of the masking shape did not
      (`test/channel-secret-listing.test.js`).
- [x] Automated (OPS-04, the value stops existing): the next `saveChannelMeta` / `setUser` write
      drops the dead field from the stored record while preserving every other key, and schema
      migration 20 deletes it from the channel and user rows that already hold one — idempotently,
      leaving rows without one (and an unparseable blob) byte-identical
      (`test/channel-secret-listing.test.js`).
- [ ] Live (OPS-04 remediation): on a deployment that stored a Skills Manager token, confirm after
      the upgrade that `sqlite3 ~/.channelgate/gateway.db "SELECT data FROM channel_meta"` contains
      no `skillsToken`, and rotate the exposed token in the issuing system (nothing needs
      re-entering in ChannelGate — the integration is retired).
- [ ] **Retired 2026-09-03 (Linux + containers only):** nothing replaces it — no host sandbox, no user namespace to exempt. **Linux userns sandbox:** on an Ubuntu 23.10+ host, `sudo sh scripts/apparmor/claude-userns-fix.sh
      --check` reports `RESULT: host OK` (after `--apply` if needed); a sandboxed `claude -p "run:
      echo ok"` in a folder with `{"sandbox":{"enabled":true}}` prints `ok`; with the profile removed
      the daemon logs `[gateway] WARNING: AppArmor restricts unprivileged user namespaces …` at boot.
      Unit: `test/linux-userns.test.js` (verdicts for restricted/no-profile, profile installed, knob
      absent, Debian hard-off, a non-Linux platform, and the stale pre-Codex profile that lacks the `codex-userns`
      block). Live: with the updated profile applied, an approved-network Codex channel's Bash
      `curl https://api.github.com/` returns HTTP 200 while an unlisted domain stays blocked
      (QA case DRV-04; before the codex-userns block both reset with curl exit 56).

## Review remediation (2026-07)
Unit layer first: `npm test` (node:test over `test/`) must pass — it pins the pure helpers
(escaping, chunking, queue, TTL set, child-env, containment, backoff, slugify, cron catch-up).
Manual checks for the daemon-level behavior:
- [ ] **Env confinement:** in a bash channel, `printenv` shows NO `SLACK_*`, `CG_APPROVAL_SECRET`,
      or `ADMIN_PASSWORD`; `git push` (HTTPS + gh) still works in the dev channel.
- [ ] **Codex-path IPC:** in a Codex channel, `run_in_background` works (internal-auth.json
      fallback); the job's continuation posts back into the thread.
- [ ] **Tokens off argv:** `ps aux | grep claude` during a run shows `--mcp-config <tmp path>`,
      never inline JSON with tokens.
- [ ] **Admin bind/lockdown:** default install binds 127.0.0.1; with `CG_BIND_HOST=0.0.0.0` and
      no password, `/api/*` (except health/login) returns 403; `/internal/*` refuses non-loopback.
- [ ] **workDir containment:** setting a channel workDir outside the allowed root is rejected in
      the UI AND the MCP tool; a pre-existing out-of-root value falls back to the default folder
      at run time (warn in logs) and does NOT block unrelated saves.
- [ ] **Escaping everywhere:** a reply containing `<!channel>` / `<@U…>` renders as literal text
      in chunked replies, streamed replies, scheduled-run posts, and background continuations;
      `@Display Name` still becomes a real mention.
- [ ] **Thread serialization + stop:** a second message gets the steer-or-queue card; choosing queue
      runs it sequentially after the active turn. `stop` kills the running turn AND discards accepted
      queued ones — including a turn parked on the global semaphore (no late side effects/answer).
- [ ] **Restart durability:** restart the daemon while one turn runs and a second is queued —
      boot recovery re-runs BOTH; neither message is lost.
- [ ] **Long answers:** a >12k-char answer arrives as multiple messages with valid code fences
      in every part (stream + tool-only + scheduled paths); nothing silently truncated.
- [ ] **Event dedupe:** a redelivered Socket Mode envelope (kill the socket mid-ack) does not
      double-run the turn.
- [ ] **/clear replay gate:** after `/clear`, the next reply does NOT re-inject thread history;
      a brand-new thread the bot joins DOES get the one-time replay.
- [ ] **Approvals:** an approved member in an access:"approved" channel can approve another
      member's tool prompt; a non-admin in an admins-only channel cannot; "Approve forever" is
      admin-only.
- [ ] **Model validation:** saving a bogus model in the admin UI (channel/DM/template) returns
      400; Slack `/model` only exposes validated picker values, and valid values still save.
- [ ] **Warm watchdog:** a wedged warm turn times out (COMMAND_TIMEOUT), the session dies, and
      the next message in the thread works.
- [ ] **Scheduler catch-up:** a tick delayed past a minute boundary still fires that minute's
      cron exactly once; one-time schedules never double-fire.
### Scheduling restart durability

- [x] Automated: `node --test test/scheduler-restart.test.js test/cron-catchup.test.js
      test/durable-delivery.test.js test/schedule-daily-thread.test.js
      test/automation-release-regressions.test.js` covers a restart spanning the due minute,
      replay refusal in a fresh process using the same scratch SQLite database, the five-minute
      limit, creation/re-enable/cron-edit boundaries, legacy last-run markers, epoch-minute claims,
      queued-versus-running crash checkpoints, saved-output delivery, brief transport outage,
      busy-run admission, immediate startup and nested provider error sentences. No live providers.
- [ ] **SCH-RESTART-01 — Claude and Codex, separately.** Fixture: an isolated acceptance daemon
      with a connected Slack test channel, approved creator, and channel engine explicitly set to
      the engine under test. Create a daily task at the next daemon-local minute after T+2:
      prompt `Append one line SCH-RESTART-01 to uploads/schedule-restart.txt and report the line count.`
      Record schedule ID, cron and daemon zone. Stop the acceptance daemon ten seconds before the
      due minute and start it one minute after, keeping total outage under five minutes. Pass:
      one scheduled engine execution, one added line, one delivered result, durable
      `lastCronFireMs` equals the missed minute. Restart again within that minute; no second
      execution, line or result. Never use the production daemon for this crash fixture.
- [ ] **SCH-RESTART-02 — Claude and Codex, separately.** Same isolated daemon/channel and prompt
      with marker SCH-RESTART-02. Arrange two daily tasks: one due two minutes before boot and one
      due ten minutes before boot, both created earlier. Pass: only the recent task executes.
      Also create/re-enable/edit a cron after its matching minute; restart within five minutes.
      Pass: no task runs for a minute before its current eligibility boundary.
- [ ] **SCH-RESTART-03 — Claude and Codex, separately.** Same isolated fixture. Use prompt
      `Append SCH-RESTART-03 to uploads/schedule-effects.txt, then wait for further instructions.`
      Kill only the acceptance daemon once its persisted schedule says `executionState:running`,
      then restart. Pass: schedule becomes disabled/interrupted, the channel explains unknown
      external effects, and no second engine execution or append occurs. Separately interrupt
      after a saved `pendingDelivery` checkpoint using a transport failure fixture. On restart,
      pass only if the saved result delivers without a new engine execution or tool side effect.
- [ ] **SCH-RESTART-04 — engine-independent reminder delivery.** Same isolated daemon/channel;
      create a reminder due next minute. Confirm its `lastCronFireMs` persists before the mock
      transport accepts the post. Simulate a crash at that boundary and restart. Pass: no replay
      post. Record the intentional at-most-once limit: an ambiguous external post can be lost;
      this case must never be described as guaranteed exactly-once delivery.
- [ ] **SCH-ERROR-01 — Claude and Codex, separately.** Isolated acceptance daemon with a synthetic
      engine/provider fixture failing with `{"error":{"message":"The selected model is unavailable."}}`.
      Fire an ordinary scheduled task. Pass: failure notice contains the sentence only, without
      raw JSON, and the execution checkpoint is interrupted rather than automatically replayed.

- [ ] **Daily schedule threads:** create an hourly task with `delivery:"daily-thread"`; its first
      run today creates one top-level “Running” anchor and threads the result, later runs today add
      results to that same thread without another top-level banner, a daemon restart preserves the
      anchor, and tomorrow's first run creates a new anchor. Repeat with Claude and Codex and prove
      each execution still receives a fresh engine session.
- [x] Automated — daily-thread sessions: two fires of one daily-thread schedule on the same day
      run under DISTINCT synthetic session keys (neither resumes the other; the spawned argv
      carries no `-r`) while both answers post under the one anchor of the day
      (`test/schedule-daily-thread.test.js`, `test/durable-delivery.test.js`).
### Skills platform (governance and usage)

- [x] Unit/API: migration 19 preserves existing discoverability; catalog search covers source
      label and filters by source/category; catalog governance/assignment queries filter Enabled,
      Discoverable, Mandatory and Assigned independently; transitions enforce Mandatory ⇒ Enabled
      + Discoverable, while disabling removes the mandatory grant.
- [x] UI: Usage is the first tab and auto-loads the top 20 for 30 days, Templates is second and has
      no category or conversation-assignment controls, Catalog keeps Owner, Category, Source and exposes Enabled,
      Discoverable, Mandatory and Assigned filters plus the three governance checkboxes, all usage
      lists sort descending, and user-facing tables have one Usage column.
- [x] MCP: ordinary users search discoverable skills plus skills already active here by query,
      category or source; managers change channel skills/templates; only admins may call
      `set_skill_governance`.
- [ ] Live engine-independent: verify Catalog filtering/governance and the Overview top-ten chart.
- [ ] Live Claude + Codex: search for a discoverable skill, grant/revoke it in the channel, change
      the template, and confirm a mandatory skill materializes on the next turn in both harnesses.

### Transactional self-update

- [x] Unit: exclusive reservation, live-owner refusal, dead/abandoned-owner recovery, ownership
      checks, atomic state transitions, terminal idempotency, and strict non-secret public status.
- [x] Unit: configured Claude/Codex smoke uses a disposable confined container with memory/dreaming off,
      no MCP/bypass, a fixed exact response, the shared stall watchdog, and unconditional cleanup.
      Engines that passed baseline must pass after restart. Internal route requires loopback plus the daemon secret.
- [x] Unit: disk sizing covers dependency/recovery staging plus explicit missing-Whisper space;
      high/critical audit counts block while moderate counts are preserved; readiness requires a
      replacement instance on the expected boot revision, container runtime, and prior Slack connectivity.
- [x] Unit: successful candidate phases, preflight refusal before mutation, post-checkout rollback,
      rollback failure, targeted systemd `MainPID`, wrapper/provisioning contracts (launchd support
      retired 2026-09-03 — Linux only),
      exact Admin 202/409 behavior, transaction-bound markers, all four final result messages, and
      durable browser polling are covered.
- [x] Automated acceptance (2026-07-24): `npm audit --omit=dev --audit-level=high` exits 0 with
      zero high/critical findings; the two reviewed moderate transitive findings are documented in
      `SECURITY.md`; `npm test` passes 493/493 with 0 failed and 0 cancelled.
- [ ] **One transaction under contention:** start updates nearly simultaneously from Admin UI and
      Slack/MCP/CLI. Exactly one runner owns `update.lock`; every other caller returns the same
      active transaction and no second `npm ci`, restart, or rollback occurs.
- [ ] **Preflight refusal is non-mutating:** separately force a dirty tracked tree, inaccessible Git
      upstream, divergent branch, malformed settings, insufficient calculated disk, missing active
      service, and failing baseline Claude smoke. Each returns `refused`; Git revision and
      dependencies remain unchanged.
- [ ] **Candidate success:** with origin one safe commit ahead, start from `/update`. The dashboard
      follows the same transaction id through phases; the candidate restarts on the expected
      revision; Slack reconnects; the real gated Claude smoke passes; the requesting thread receives
      exactly one `updated` message; a later restart does not repost it.
- [ ] **Automatic rollback:** inject a candidate-only post-restart smoke failure. The checkout and
      lockfile dependencies return to the recorded old revision, the service restarts again, the
      same health/smoke gate passes, status is `rolled_back`, and Slack/Admin report the candidate
      error without claiming success.
- [ ] **Rollback failure:** also break restored-build readiness. Status is `failed` with separate
      candidate and rollback summaries; `update-backups/<transaction>/` remains available for
      operator recovery and runtime DB/config are not auto-restored.
- [x] Unit (2026-08-25): the updater reads a health payload it can actually gate on — the real
      `healthAt()` against the real `/api/health` returns a `revision` that satisfies
      `baselineFailure()`; the same-machine internal secret unlocks the detail view while a wrong
      secret and a non-loopback caller still get only `{ok,instanceId}`. This is the HTTP seam the
      updater unit tests and the health-endpoint test each covered one side of while the flow
      between them was broken. → `run-api.test.js`.
- [x] Unit (2026-08-25, revised 2026-09-03 — Linux only): `serviceProbes()` is systemd-only, BOTH
      scopes (system, then `--user`), with no platform-derived variant left (the launchd probe
      retired); the refusal names only systemd, and the detected scope rides on the service record
      so the restart asks `systemctl` in the same scope. → `update-runner.test.js`.
- [ ] **Service portability:** repeat candidate success and rollback on a Linux SYSTEM unit and on
      a box whose daemon is a USER unit at `~/.config/systemd/user/channelgate.service`. Systemd
      signals only the validated positive `MainPID` (the macOS launchd leg retired 2026-09-03 —
      Linux only).

### Codex usage accounting and API-equivalent rates
- [ ] Settings → Behavior shows the Codex/OpenAI rates table prefilled with the rates verified
      2026-08-16 against OpenAI Standard pricing
      prices; editing a cell and saving persists it (reload shows the edited value; the others
      keep defaults). The old blended `$/1M` fallback input is not shown.
- [ ] A Codex run's footer shows the estimated `$x.xx` API-equivalent value and Activity records the same figure
      with the estimated flag; a Claude run still shows the real `$` cost (never an OpenAI-rate
      estimate, even if total_cost_usd were missing).
- [x] Unit: Terra/Luna current defaults, retired-default migration with custom override preservation,
      nested cache-read/cache-write pricing, official model-boundary matching, unresolved-model
      behavior, and the 272K threshold applied per request (`test/codex-rates.test.js`).
- [x] Unit: one provider session is serialized across gateway keys; aborted waiters do not strand
      the lock (`test/keyed-lock.test.js`).
- [x] Unit: root rollout deltas, resumed baselines, actual runtime model/context metadata, child
      copied-prefix exclusion at second precision, and nested usage normalization
      (`test/codex-usage-accounting.test.js`, `test/model-info.test.js`).
- [x] Unit: canonical root+child components replace cumulative raw totals without adding runs,
      request replacement is idempotent, migration v10 upgrades old databases, and historical
      cumulative rows reconstruct to per-turn deltas with fork children attached
      (`test/usage-components.test.js`, `test/usage-repair.test.js`, `test/migrations.test.js`).
- [x] Live repair drill: run `npm run usage:repair`, confirm a frozen cutoff and explicit unmatched
      coverage, then `npm run usage:repair -- --apply`; verify the reported consistent backup opens,
      rerunning is idempotent, Claude/provider rows are unchanged, and Overview totals use canonical
      root plus native-child usage while run count remains the raw run count.
- [x] Unit: boot-time auto-repair triggers only when legacy codex rows exist past the last applied
      batch cutoff, applies the shared repair path with a backup, records a batch even when nothing
      matches, and never rescans settled history (`test/usage-repair.test.js`).
- [x] Unit: a DM resolves ONLY `composio-user` — the channel token and the organization default are
      both refused (`source: "none-dm"`) in Personal mode, and SDK mode mints no channel session at
      all; channels/mpims keep both identities (`test/composio-resolution.test.js`,
      `test/composio-sdk-run.test.js`).
- [x] Unit: the shared Composio server is emitted as `composio-agent` for Claude (`mcpServers`) and
      Codex (`mcp_servers.composio-agent.*`), the bare `composio` key is never emitted, and the
      pre-approval namespace is `mcp__composio-agent` (`test/mcp-config.test.js`,
      `test/codex-args.test.js`).

## ChannelGate rename, per-platform folders, and the boot migration (S4)

- [x] Unit: with no env set the runtime root is `~/.channelgate` (DB `~/.channelgate/gateway.db`)
      and the workspace root is `~/ChannelGate`; `CHANNELGATE_DIR`/`CHANNELGATE_DB` override them
      (`test/channelgate-rename.test.js`).
- [x] Unit: the pre-rename `CLAUDE_GATEWAY_DIR`/`CLAUDE_GATEWAY_DB` still resolve, each warns
      exactly ONCE per process (they are read on nearly every path lookup), and the new name wins
      when both are set (`test/channelgate-rename.test.js`).
- [x] Unit: every platform adapter declares a unique, lowercase, single-component `folderName`
      (`slack` / `teams` / `google-chat`); a descriptor missing it, or declaring `a/b`, `..`, or
      `Teams`, fails validation; an unknown/empty/`null` platform resolves to Slack's folder
      (`test/channelgate-rename.test.js`, `test/platforms.test.js`).
- [x] Unit: `workspaceFolder`, `channelFolder`, `channelMetaFile`, `channelSessionsFile`,
      `channelSettingsFile`, `channelAdminSettingsFile`, `channelSkillsDir` and
      `cleanWorkspaceFolder` all carry the platform component, and omitting the platform yields the
      Slack folder (`test/channelgate-rename.test.js`).
- [x] Unit: a Teams channel's generated `.claude/settings.json` sits under
      `channels/teams/<slug>/`, its sandbox `allowWrite` names `<workspace>/teams/<slug>`, the
      runtime root is still read-denied wholesale, and no pre-rename root appears anywhere in the
      file (`test/channelgate-rename.test.js`).
- [x] Unit: a channel that materialised the bundled lockdown skill under the OLD name gets the
      folder renamed to `channelgate` on its next message, a grant still stored under the old name
      resolves to the new one, and an unmarked (hand-made) folder with the old name is never
      touched (`test/channelgate-rename.test.js`).
- [x] Unit: `package.json`/`package-lock.json` agree on `channelgate` (still `private`, same
      license), and `slack-app-manifest.json` parses, is renamed, and keeps all 21 bot scopes and
      11 bot events (`test/channelgate-rename.test.js`).
- [x] Unit: `bash -n` passes on the service scripts; they carry `com.makeitfuture.channelgate` /
      `channelgate.service`, remove the pre-rename label/unit BEFORE installing (so one runtime
      root never has two daemons), derive the working directory from the script's own location, and
      the uninstaller removes both labels. Self-update probes the new unit/label first and the old
      one second, with `CHANNELGATE_SYSTEMD_UNIT` (and legacy `CLAUDE_GATEWAY_SYSTEMD_UNIT`)
      overriding (`test/channelgate-rename.test.js`).
- [x] Unit (guard): `git grep "Claude Gateway"` hits only the allowlisted "formerly" attributions
      and the published CHANGELOG/LICENSE history, with a per-file hit cap; no shipped file under
      `src/`/`public/` names a pre-rename root or label outside four documented exceptions
      (`test/channelgate-rename.test.js`).
- [x] Unit (migration, temp fixture — two Slack channels, one Teams channel, one custom-`workDir`
      channel): the runtime root moves, `channels/<slug>` → `channels/<platform>/<slug>`,
      `clean-workspaces/<slug>` → `clean-workspaces/<platform>/<slug>`, and
      `~/Slack Agent/<slug>` → `~/ChannelGate/<platform>/<slug>` with content intact; the custom
      `workDir` project is not moved and gets no platform folder; `MOVED.md` breadcrumbs are left in
      both old roots and the old runtime root holds nothing else
      (`test/migrate-channelgate.test.js`).
- [x] Unit (migration): a stored background job's `cwd` and `logFile`, and `update-state.json`'s
      absolute paths, are repointed at the new locations, while a custom `workDir` outside the moved
      roots survives verbatim; rewrite rules are boundary-aware (`channels/ops` never matches
      `channels/ops-archive`) and most-specific-first (`test/migrate-channelgate.test.js`).
- [x] Unit (migration): every channel's `.claude/settings.json` is regenerated through
      `ensureChannelFolder`, replacing the stale pre-rename file with one whose sandbox names the
      new absolute paths (`test/migrate-channelgate.test.js`).
- [x] Unit (migration): `--dry-run` prints the plan — including each channel's source → destination
      and "custom workDir — left untouched" — and creates neither new root, moves nothing, and
      writes no breadcrumb (`test/migrate-channelgate.test.js`).
- [x] Unit (migration): with no `CHANNELGATE_DB` set — the shape a real un-migrated machine has —
      a dry run reads the OLD database read-only and does not create the new runtime root. Opening
      it through `getDb()` would create that root, and the real migration would then refuse to move
      anything because the destination exists (`test/migrate-channelgate.test.js`).
- [x] Unit (migration): an existing destination is never clobbered — the source is left in place and
      the skip is reported; re-running the migration afterwards is a no-op
      (`test/migrate-channelgate.test.js`).
- [x] Unit (migration): an injected `rename` that throws `EXDEV` falls back to copy → verify →
      remove; a copy that drops a file, or truncates one, fails verification and leaves the source
      intact (`test/migrate-channelgate.test.js`).
- [x] Unit (migration): it refuses while `gateway.lock` is held by a live pid, while `update.lock`
      is held by a live pid, or while a `bg_jobs` row's pid is still alive — moving nothing — and a
      dead pid in a lock is not a blocker. After a refusal `applyFallback` pins `CHANNELGATE_DIR`
      and `CG_WORKSPACE_DIR` back to the pre-rename roots (env override, not a symlink) so the
      daemon serves from where the data actually is (`test/migrate-channelgate.test.js`).
- [ ] Live drill (Linux, on a scratch HOME; the macOS leg retired 2026-09-03 — Linux only): seed a pre-rename install, run
      `node scripts/migrate-channelgate.mjs --dry-run`, review the plan, then boot the daemon and
      confirm zero lost channels/memory/schedules, a regenerated sandbox per channel, and that
      `sudo bash scripts/install-systemd.sh` leaves exactly ONE service registered under the new
      name.
- [x] Unit (migration go/no-go): the decision is made on gateway STATE (`gateway.db` or `config/`),
      not on a directory existing. A new root that exists but holds no state is a leftover — the old
      install is merged into it entry by entry, the leftover survives, and a colliding name is
      reported with the old copy left in place. A new root that already holds `gateway.db` is never
      touched and the old root is left intact (no breadcrumb, nothing moved). An empty
      `~/ChannelGate/` does not stop the per-channel work folders from moving
      (`test/migrate-channelgate.test.js`).
- [x] Unit (migration): `--dry-run` bypasses the busy gate — previewing while the daemon is up is
      the point — reports it as the FIRST plan line (`busy: … — a real run would refuse right now`),
      prints the complete per-channel plan, and creates neither new root nor a breadcrumb; the same
      fixture run for real still refuses (`test/migrate-channelgate.test.js`).
- [x] Runner guard: `scripts/run-tests.mjs` snapshots `~/.channelgate`, `~/ChannelGate`,
      `~/.claude-gateway` and `~/Slack Agent` (plus one level beneath each) before and after the
      suite and fails the run on any NEW entry, so a test file that forgets `ensureTestEnv()` and
      provisions folders in the operator's real home can no longer pass silently. Proven by removing
      the pin from `test/opencode-adapter.test.js`: the run fails and names the leaked paths.

### Licensing — keys, tiers, and usage limits (`src/ee/`)

Every check below runs offline: the platform is never contacted, `fetch` is injected, and the test
environment installs its own Ed25519 keypair through `CHANNELGATE_LICENSE_PUBLIC_KEY` plus a signed
offline payload (`test/helpers.js` → `testLicenseEnv()`). Nothing is stubbed out inside `src/ee/`:
the suite runs as an enterprise deployment because it holds a license it actually signed.

- [x] Unit (production trust root): with no environment override, the platform defaults to
      `https://channelgate.dev`, the compiled key is a valid
      Ed25519 public key, differs from the retired development placeholder, and does not raise the
      placeholder warning; an escaped-newline environment override still wins for staging and
      coordinated rotation (`test/license-public-key.test.js`).
- [x] Unit (signature): a correctly signed license verifies; a tampered field, a wrong-length or
      garbage signature, a signature from a different keypair, the real signature against a foreign
      public key, and a malformed PEM all return `false` without throwing. Canonical JSON sorts
      object keys recursively, preserves array order, emits no whitespace, and matches an
      independent encoder in the test (so encoder drift is caught) (`test/license-verify.test.js`).
- [x] Unit (shape): a signed payload naming an unknown tier, or missing `keyId`, is refused —
      signature and shape are independent checks, so a forged "platinum unlimited" cannot be read
      as "probably fine" (`test/license-verify.test.js`).
- [x] Unit (verify round trip, injected fetch): `200` + good signature caches and becomes `valid`;
      `200` + a signature from another key caches NOTHING and lands in `grace` on the previously
      verified tier (an unauthenticated response can neither upgrade nor downgrade); `401` →
      `invalid`, `403` → `revoked`, both on the no-key limits; a thrown fetch, a `500`, and an
      `ok:false` body are all `unreachable`, never a throw. The request body is exactly
      `{key, installationId, version}` and the installation id is a UUID v4
      (`test/license-verify.test.js`).
- [x] Unit (state machine, fake clock): `resolveLicenseState()` is driven at chosen instants —
      no key; a key never yet verified (grace, no-key limits, banner says so); fresh success
      (`valid`); `invalid`/`revoked` dropping immediately with an error banner; unreachable at days
      0/1/7/13.9 keeping the tier; day 20 still keeping it (`expired_grace`, `fellBack:false`); the
      fallback landing exactly at the next UTC month start (23:59:59 on the 30th vs 00:00:00 on the
      1st); grace that ends mid-July waiting for 1 August, not 1 July; a December verification
      rolling into the next year; a cached payload past its own `expiresAt` unable to stay `valid`;
      and every declared state being reachable and every reachable state declared
      (`test/license-state.test.js`).
- [x] Unit (OPS-11 regression — expiry fails CLOSED): a licence past its own `expiresAt` resolves to
      `expired`, not `grace` — the no-key limits, `license: null` so nothing downstream reads a tier
      off it, `expiredAt` kept for the card, and an error banner naming the date. Checked at +0.1,
      +15 and +400 days with the verifiedAt an offline payload actually carries (read time), which is
      what made the old grace window impossible to leave. The same payload an hour before its expiry
      is still `valid`; `expiresAt: null` and an unparseable date never expire
      (`test/license-state.test.js`).
- [x] Unit (OPS-11 regression — the grace lane is intact): a still-in-date licence the platform
      could not re-check is `grace` on its own tier at day 9 and `expired_grace` on the same tier at
      day 20, exactly as before (`test/license-state.test.js`).
- [x] Unit (OPS-11 regression — end to end through the gate): a real signed OFFLINE enterprise
      payload with a past `expiresAt` yields `state: "expired"`, a tier that is not `enterprise`,
      the no-key limits, and an admission that serves the first conversation of the month and
      refuses the second (`conversation_limit`); the identical payload with a future expiry is the
      unlimited enterprise tier it always was (`test/license-limits.test.js`).
- [x] Unit (UTC months): the ledger month is UTC, so 23:30 on 31 December is still December even
      where it is already January locally (`test/license-state.test.js`).
- [x] Unit (admission, no key): the first conversation of the month is served and every other one
      is refused with the notice ("limited to 1 conversation without a license key … get a free key
      at …"); the admitted set is persisted, so the refusal is stable rather than first-come per
      message; a refused conversation never accrues runs (`test/license-limits.test.js`).
- [x] Unit (admission, free key): every conversation is admitted across all three platforms' id
      shapes; the 500-message cap holds per conversation; the 80 % warning fires on run 400, once
      per month, quoting the count; run 501 is refused with the upgrade notice and is not counted;
      a second conversation on the same key is unaffected (`test/license-limits.test.js`).
- [x] Unit (admission, enterprise): 60 conversations and 600 runs in one conversation are all
      admitted, no warning is ever produced ("there is no 80 % of unlimited"), and usage is still
      counted — just never enforced (`test/license-limits.test.js`).
- [x] Unit (exemptions): memory-review runs are exempt by origin (`memory_review`) AND by toolset
      (`CG_TOOLSET=memory-review`), run against a conversation that is not in the allowed set, and
      leave no row in the ledger. Every other origin (slack/api foreground, schedule, background
      agent, continuation, recovery, diagnosis) counts (`test/license-limits.test.js`).
- [x] Unit (month rollover): the ledger is keyed on `(UTC month, conversation)`, so the next month
      admits a different first conversation while the previous month's rows stay intact
      (`test/license-limits.test.js`).
- [x] E2E (the enforcement point, real `runMessage`): without a key the first DM answers normally
      and the second is refused — `licenseRefused:true`, `licenseReason:"conversation_limit"`, the
      notice as `content`, `costUSD`/`durationMs` zeroed, `sessionId` null, and `cwd:""` proving no
      folder was provisioned for a turn that never ran. A refused `schedule`-origin turn produces
      the same non-empty deliverable notice (deliverResult posts `result.content`, so a daemon
      origin announces itself instead of dying quietly). A licensed deployment admits every
      conversation and prefixes nothing (`test/license-run-gate.test.js`).
- [x] Unit (outbound payload): the usage report has exactly the keys
      `{installationId, keyHash, version, month, conversations}`; every conversation entry is
      `{hash, count}` with a 64-hex hash; the key hash is the SHA-256 of the key; and the serialized
      report contains none of the conversation ids, none of the channel names, and not the key
      (`test/license-verify.test.js`).
- [x] Unit (offline license): a payload signed with the deployment's public key verifies locally,
      yields `valid`, and makes NO request (the injected fetch throws if called); a payload signed
      by any other key is ignored and the install falls back to the no-key limits
      (`test/license-verify.test.js`).
- [x] Unit (admin API): the settings listing carries `hasLicenseKey` + `licenseKeyLast4` and never
      the key, including in the PUT's own echo; `licenseKey` is on the reveal allowlist and comes
      back one at a time while a neighbouring non-allowlisted field is refused; clearing the key
      returns the deployment to `no_key` with the compiled-in limits; `GET /api/license` carries the
      state, tier, organization, limits, banner and this month's per-conversation usage but never
      the key; the platform URL round-trips, is normalized, restores the ambient value when cleared
      and falls back to the compiled-in default when unset anywhere; `POST /api/license/verify`
      answers `200` with `outcome:"unreachable"` and a warn banner against a dead platform rather
      than failing the request (`test/license-admin-api.test.js`).
- [x] Unit (MCP authz, real stdio server): all three tools register on a full run;
      `get_license_status` is answerable by a NON-admin, shows the key's last four and never the
      key, and raises no approval card; a non-admin's `set_license_key`/`clear_license_key` gets the
      handler refusal with no approval spam and changes nothing; an admin's call raises exactly one
      approval card whose `requiredTier` is `admin` and whose payload never contains the key, and a
      denial changes nothing; an approved call saves the key, reports the honest verification
      outcome, tells the author to delete the message, and still never echoes the key; a too-short
      key is refused before anything is saved (`test/license-mcp-tools.test.js`).
- [x] Unit (migration 12): `license_usage` does not exist at v11 and does at v12 with exactly the
      expected columns; a fresh database reaches it in one pass, `(month, conversation_id)` is
      unique, the same conversation in a different month is a separate row, and the month index
      exists; a POPULATED v11 database upgrades with its `users` and `usage` rows intact and an
      empty licence ledger; re-running migrations on an already-migrated database changes neither
      the schema nor the rows (`test/license-migration.test.js`).
- [x] Drift tripwire: `test/mcp-control-plane-approval.test.js` classifies `set_license_key` /
      `clear_license_key` as GATED and `get_license_status` as OPEN, so a future licensing tool
      cannot ship approval-free by omission.
- [ ] Live drill (needs the platform): install a real free key, confirm `valid` and the tier in the
      admin card; revoke it on the platform and confirm the next check lands on `revoked` with the
      banner and the no-key limits; block egress and confirm `grace` keeps the tier and the banner
      appears; confirm the usage report arrives at the platform with hashes only.
- [x] Unit: the Claude project-directory encoder reproduces Claude Code's own rule — every
      character outside `[A-Za-z0-9]` becomes `-` (so `.claude-gateway` → `-claude-gateway`, hence
      the double dash), names over 200 characters truncate to 200 plus a base-36 hash of the FULL
      path, and two long siblings do not collapse onto one name
      (`test/migrate-channelgate.test.js`). Verified against the shipped CLI (v2.1.246) and against
      the production install: 11 channel project directories plus the engine home matched exactly.
- [x] Unit: text repathing is boundary-aware and URL-safe — `<ws>/ops` does not match
      `<ws>/ops-archive` or `<ws>/ops.bak`, a trailing dot that ENDS A SENTENCE is a boundary so
      prose is repathed, and a path inside `https://…` is left alone
      (`test/migrate-channelgate.test.js`).
- [x] Unit (migration): Claude project directories are renamed to the encoding of the channel's NEW
      cwd — derived through the encoder, never by string-replacing the old name — for both a moved
      channel folder and the engine home itself; a project belonging to an unrelated cwd is
      untouched; every `cwd` field in the transcripts and in the per-session `subagents/` tree
      follows; a line that mentions no moved path is preserved BYTE for byte; and
      `<engineHome>/.claude/.claude.json`'s cwd-keyed `projects` map is rekeyed
      (`test/migrate-channelgate.test.js`).
- [x] Unit: a transcript line that mentions a moved path and does not parse aborts that file and
      leaves it byte-identical — a half-rewritten transcript is worse than an un-migrated one
      (`test/migrate-channelgate.test.js`).
- [x] Unit (migration): Codex follows too — the `threads` index's `rollout_path` column (a plain
      TEXT column, updated by statement), each rollout's `cwd` header line, `config.toml`'s
      `[projects."…"]` sections, and `shell_snapshots` (`test/migrate-channelgate.test.js`).
- [x] Unit (migration): typed database columns holding a bare path are rewritten
      (`usage_repair_batches.backup_path`), while the historical `events` log is left exactly as it
      was — rewriting an audit trail would make it record something that did not happen
      (`test/migrate-channelgate.test.js`).
- [x] Unit (migration): `config/mcp-catalog.json` (a local MCP server's `args` naming a path), the
      pre-SQLite per-channel JSON backups, and the agent's own prose (`MEMORY.md`,
      `memory/<topic>.md`, `CLAUDE.md`) are repathed; the content-addressed per-run caches under
      `channels/**/runtime/` are DELETED rather than rewritten, because their filename is a digest
      of their contents (`test/migrate-channelgate.test.js`).
- [x] Unit (migration): the installed systemd user unit has its runtime-root paths rewritten (the
      launchd plist rewrite retired 2026-09-03 — Linux only) while an unrelated `WorkingDirectory`
      is left alone, and a
      `service-reload-required.json` marker is written for the updater
      (`test/migrate-channelgate.test.js`).
- [x] Unit: `applyPendingServiceReload()` consumes that marker exactly once — `daemon-reload` in the
      unit's own scope (system or `--user`) before the systemd restart signal; the launchd
      `bootout` + `bootstrap` path and its `restarted` flag retired 2026-09-03 (Linux only)
      (`test/update-runner.test.js` seam, `test/migrate-channelgate.test.js`).
- [x] Unit: `--verify` / `auditLegacyPaths()` names every store on a fresh fixture (project
      directories, transcripts, Codex state, work-folder text, config JSON), and reports 0 after a
      real run; `formatAudit` prints the roots it scanned and the total
      (`test/migrate-channelgate.test.js`).
- [x] Unit: a dry run renames no project directory, leaves the Codex index and `config.toml`
      untouched, and still ends with the pre-migration audit plus a "would leave N occurrence(s)"
      line (`test/migrate-channelgate.test.js`).
- [x] Unit: `--verify` bills STATE only. A transcript whose message text, tool `command` and
      `toolUseResult.stdout`/`filePath` quote a pre-rename path reports `total = 0` with those
      occurrences in the "historical content" bucket, and a `--repath` over the same file leaves it
      byte for byte — rewriting it would edit what was said (`test/migrate-channelgate.test.js`).
- [x] Unit: a channel whose CUSTOM `workDir` really is `~/Slack Agent/<slug>` keeps its folder and
      its Claude project directory; the directory is NOT flagged as a stale name (its name is the
      correct encoding of a cwd that still exists) but IS listed under "still on disk", and it does
      become a finding the moment that directory is deleted (`test/migrate-channelgate.test.js`).
- [x] Unit: `classifyJsonPaths()` splits by JSON key path for both engines — Claude `cwd` is state
      while `message.content[]`, `toolUseResult.*` and the path-shaped KEYS of
      `snapshot.trackedFileBackups` are content; Codex `payload.cwd` + `payload.workspace_roots[]`
      are state while a `world_state` snapshot (`state.environments.filesystem`,
      `state.agents_md.directory`, `state.environments.environments.local.cwd`) is content; and a
      match returns the WHOLE path token, which is what the existence check needs
      (`test/migrate-channelgate.test.js`).
- [x] Unit: `--repath` on an already-migrated fixture repairs a transcript `cwd`, `mcp-catalog.json`
      and a channel `MEMORY.md` left behind by a hand migration, moves no root or channel folder,
      ends with a post-repath audit of 0, and a second run rewrites nothing (`rewrittenRows`,
      `rewrittenFiles`, `claude.occurrences`, `codex.occurrences`, `workFolders.occurrences` all 0);
      `--dry-run --repath` previews and repairs nothing. A content-addressed run cache holding an
      old path is dropped; one that is already correct is left alone, so a repath never cold-starts
      a healthy install (`test/migrate-channelgate.test.js`).
- [x] Unit: `--repath` refuses while a live `gateway.lock` holds the runtime root, and a dry run
      reports the blocker and previews anyway (`test/migrate-channelgate.test.js`).
- [x] Unit: `--repath --from <old> --to <new>` on a migrated fixture whose custom-workDir channel
      was moved by hand: the channel record, the Claude project directory (renamed) and its
      transcript `cwd`, the engine home `.claude.json`, Codex `config.toml`, the moved folder's
      `MEMORY.md` and the regenerated sandbox all name the new folder, a stale run cache is dropped,
      the post-repath audit is 0, and a second run with the same pair rewrites nothing; without the
      pair the audit does not see the folder at all, with it `--verify` counts every stale store and
      names the path in its header; `--dry-run` previews the rule and changes nothing
      (`test/migrate-channelgate.test.js`).
- [x] Unit: `--from/--to` parsing rejects a missing `--to`, an orphan `--to`, a relative side, an
      identical pair, the filesystem root and a new path under the old one; merged rules keep the
      longest source first whatever their origin; the CLI exits 2 with usage on a malformed pair and
      on a pair given without `--repath`/`--verify` (`test/migrate-channelgate.test.js`).
- [x] Unit: the landing-lock helper's ref is `refs/channelgate/landing-lock`, a held lock shows up
      under `refs/channelgate/` and nothing is written under the pre-rename name
      (`test/landing-lock.test.js`).
- [x] Live (2026-09-03, Linux host, daemon stopped for two minutes): the production checkout
      renamed `~/Code/claude-gateway` → `~/Code/channelgate` and repathed with
      `--repath --from … --to …`: 2 channel records, 1 Claude project directory renamed with
      40 113 `cwd` fields in 211 transcripts, 1 727 Codex paths in 379 files, 3 work-folder paths,
      the user unit's `WorkingDirectory`, 40 sandboxes regenerated; `--verify` with the same pair
      reports **0** state occurrences (113 931 historical, 66 still on disk by design);
      `channelgate.service` started from the new `WorkingDirectory`, `/api/health` reports the
      fresh-start root commit as the running revision with Slack connected, and the updater's
      isolated engine smoke turn passed (2.9 s). A second deployment on the same host (another
      user, checkout not renamed) was repointed with the three `INSTALL.md` commands and restarted
      onto the same revision.
- [x] Live: `node scripts/migrate-channelgate.mjs --verify` against the production install
      (read-only), after the real migration: **0** occurrences the migration is responsible for,
      with 56 609 in historical content (19 `events` rows, 5 379 Claude message/tool occurrences in
      307 files, 51 211 Codex message/tool + `world_state` occurrences in 587 files) and 66 that
      still resolve on disk (`~/Slack Agent/dev-skillsmanager-uk` ×60,
      `~/Slack Agent/gateway-slack` ×6 — both custom-`workDir` folders that were deliberately never
      moved). Exit code 0.
# Development acceptance policy

- [ ] Each changed feature has reproducible acceptance definitions for applicable Claude/Codex
  behavior, exact setup, prompt/action, evidence and pass rules. Public contributors put these in
  the PR and report unexecuted live cases; no private service access is required.
- [ ] Maintainers record the actual private fixture identifiers and complete required live gates
  before release. Engine-independent cases must not depend on a harness.
- [x] For this remediation, the operator-selected personal QA connection was used to register
  and read back 16 active acceptance definitions: SCH-RESTART-01 through 04, SCH-ERROR-01,
  REL-RUNTIME-01 through 07, SLK-203, REL-CODEX-02, REL-DEPS-01 and REL-SKILLS-01.
  These cover 29 applicable engine executions. Registration is not execution: deployed live
  verdicts remain outstanding and automated evidence must not be recorded as a live pass.

## Container update verification and recovery

- Both Claude and Codex fixtures: configure each login, invoke the internal authenticated update smoke route, require exact CG_UPDATE_SMOKE_OK responses per engine. Verify isolated target, no bypass/MCP injection, no host engine child, and removal of the ephemeral container, HOME volume and work folders. Invalid configured credentials must fail; absent credentials must be explicitly skipped; zero probes fails.
- Image recovery: build old pins, change the desired Codex pin without changing imageSpecVersion, make the first build fail, then run Update again on the same checkout revision. Require retry and matching built/desired source digest; a build exiting zero with stale labels fails verification. Existing channels retain HOME and adopt the new image when idle.
- Admin container status: require actual built and desired Claude/Codex versions, rebuild-needed status, and count of containers awaiting adoption. A custom image reference must never report a successful default-image rebuild.
- Live acceptance fixtures: private disposable `update-smoke-<uuid>` container per gateway; authenticated local IPC only, no Slack posting. Run both engine cases on each deployment. Airtable cases must mirror these actions and exact pass evidence using the requester's personal connection.

## Real project skill synchronization and workspace reset

Automated regressions: `workspace-skill-materialize.test.js`, `workspace-skill-sync.test.js`,
`channel-workdir-ui.test.js`, folder generation and run-grant isolation suites.

Live acceptance is required on both `cg-testing-claude-auto` and `cg-testing-codex-auto`, using
a disposable real project under the allowed filesystem root. Record the deployed commit,
channel/thread, author, harness/model and the exact prompt/action with filesystem evidence.

1. Set the fixture's custom folder, select one channel skill and one organization skill, and create
   conflicting local `.claude/skills` and `.agents/skills` copies with recognizable harmless text.
   Save in the admin UI without sending a chat message. Pass: selected source bytes appear in the
   real project, unrelated local entries are absent from discovery and readable in daemon backups,
   `.agents/skills` is the canonical relative link, and unrelated project files remain intact.
2. Edit/delete/add files inside a selected copy without changing its revision marker. Prompt:
   “Read the selected test skill and report its current revision marker and the fixture sentence.”
   Pass: both engines read the selected source revision, drift is repaired on disk, and a repeated
   unchanged turn leaves skill-file timestamps unchanged. Grant a personal-only fixture to a
   different author; pass only if it never appears in the shared project.
3. Change a channel grant through MCP, update its assigned template, publish a new catalog
   revision, and revoke an organization grant. Inspect locally without sending another message.
   Pass: the next five-second reconciliation poll applies each changed shared selection, unavailable
   skills are reported, and clean mode exposes only its required protocols while the normal project
   still has its shared selection. Filesystem failures must be visible and retried.
4. On Runtime, choose a custom path, Save, then click **Reset to default** beside **Browse**.
   Pass: only the folder field becomes dirty; Discard restores the custom path; Save persists an
   empty override and the next turn uses the normal platform/slug folder. Other settings and files
   in the former custom folder stay intact. A failed Save retains the pending edit.

Airtable case/run registration and live engine verdicts remain pending until the requesting
user’s designated personal QA Airtable connection is available; automated results are not a
substitute for live passes.


## Runtime reliability acceptance — September 2026

Automated: `node --test test/container-lifecycle.test.js test/container-reaper.test.js
 test/session-engine.test.js test/message-normalize.test.js test/message-to-reply-e2e.test.js
 test/process-outcome.test.js test/engine-switch-choice.test.js test/stop-card-engine.test.js
 test/slack-progress.test.js test/runtime-integration-run.test.js`. Fixtures use fake Podman, fake Slack and stub engines with a disposable
SQLite store. No provider or production access is required. Live cases below remain unexecuted.
Local result: **159/159 focused tests passed**, static checks, secret scan and security coverage
passed. Full coverage met thresholds (92.72% lines, 82.53% branches, 87.39% functions), with one
unrelated service-path fixture failure caused by this environment’s private `/tmp` ancestor.
A rerun under another TMPDIR moved the sole failure to a separate fixture’s `/tmp` containment
assumption; it is not a clean full-suite result. Consolidated verification must use the corrected
portable fixtures before landing.

- [ ] **Mount readiness, Claude and Codex separately:** use a disposable Slack channel with an active
  daemon background shell job `sleep 90` holding its runtime lease. Change its work directory to a
  second disposable directory containing only `new-workspace.txt`. Send “Read new-workspace.txt and
  reply with its text.” Require an initial wait notice, a reminder after one minute, no engine spawn
  or container removal while the job holds its lease, and automatic recreation/read after it ends
  without resending. Repeat with two waiting threads; both finish. Repeat and send “stop” to only
  one waiting thread: that turn never spawns, the other still completes, and a later fresh turn works.
- [ ] **Unsupported resume, Codex:** in an isolated CLI fault-injection fixture with an existing thread,
  make its first resume emit exactly `thread/resume failed: list_turns is not supported yet`, then
  permit normal execution. Ask “Repeat the marker I gave you earlier.” Require exactly one fresh
  session recovery, transcript-provided marker, no harness switch. Unrelated list_turns errors and
  the same words in stdout must not reset a session. Claude uses existing missing-session cases.
- [ ] **Ambiguous kill, Claude cold and warm:** disposable channel, harmless fixture whose tool appends
  one line to `side-effect.txt`, then waits before returning its tool result. Kill only the fixture
  engine process with SIGKILL after the line appears. Require one error and no automatic continue
  or retry; the file remains one line. Audit `run_error` retains engine=claude, runtime=container,
  signal=SIGKILL or exitCode=137, processEnded=true; no invented OOM cause. Send an explicit review
  request to inspect completed work before continuing. Codex: repeat kill and require no automatic
  Claude-style continuation (its own structured diagnostics remain covered by runner tests).
- [ ] **Loop Stop, Claude and Codex:** seed a gateway-owned interval loop in a disposable channel
  (Codex does not need native Cron tools). During an active harmless tick, send “Stop the check loop
  now”; repeat between ticks with “stop the loop”. Require immediate persisted loop deletion,
  cancellation of the active tick, an acknowledgement and no future tick. “How do I stop the loop”
  must remain a normal question.
- [ ] **Throttled Stop, Claude and Codex:** use a disposable Slack API proxy holding an append and
  assistant status clear until released. Start two harmless long turns plus a queued turn and seed
  one loop; invoke channel Stop. Require all controllers aborted and the loop removed before proxy
  release; independent acknowledgement post attempts proceed; run cleanup releases within its
  one-second grace. After proxy release, delivered text is marked partial, queued text is not
  flushed as a new answer. Audit has three `run_stopped` rows with distinct run IDs (two active,
  one queued), one `run_stop_requested` summary and no duplicate rows after a repeated Stop.
  The proxy may block acknowledgement delivery itself; the gateway cannot bypass Slack throttling.
- [ ] **Mutable counts, Claude and Codex:** with `report_progress` available, request one stable stage
  updated from details “0/4 batches checked” to “2/4 batches checked” to “4/4 batches checked” and
  output “4 checks passed”. Require the same row to show only the latest numeric title, no stale
  numeric rich-detail paragraphs, and one final answer. Read-only mock rendering is automated;
  real Slack’s replacement behavior is the live gate.
- [ ] **Secondary errors, Claude and Codex:** isolated runner fixture emits nested provider JSON on
  automatic continuation or the second harness of an ask-mode fallback. Require readable provider
  sentence, no raw JSON in the message/card, and retained structured audit outcome facts.
### Runtime-owned Codex child visibility and accounting (2026-09-07)

- [x] Automated: `node --test test/codex-runtime-usage.test.js
  test/codex-message-to-reply-e2e.test.js test/codex-usage-accounting.test.js
  test/runtime-integration-folders.test.js test/container-state.test.js`.
  The real inline Node reducer executes against synthetic runtime state while the daemon-facing
  HOME volume is `/proc/1/unreadable-home-volume`. The runner must emit two named live rows and
  close those same ids with elapsed/tokens, return child usage, and never consult that host path.
  Resume fixture grows cumulative input/output 250/12 to 400/20: charged delta must be 150/8.
  A transcript sentinel must never leave the reducer; invalid JSON/exec failures must not leak
  diagnostics. Failed baseline must spawn no engine and release the session lock. Failed final
  inspection must preserve the answer and announce incomplete accounting exactly once.
- [ ] Live Codex/rootless: create a disposable approved QA channel with ordinary rootless HOME,
  full-home widening OFF, Codex pinned to the requested available model, and a work folder with
  `one.txt` containing `alpha` and `two.txt` containing `beta`. Verify as the daemon user that
  opening the HOME volume directly fails while `podman exec <fixture-container>` can read its
  Codex sessions. In a fresh thread ask: "Launch two native agents named file_one and file_two.
  Have each read its corresponding text file, wait 10 seconds, and report its word. Join both."
  Pass: live card shows both names while running; both finish on their original rows with elapsed
  time/tokens; final answer contains alpha/beta. Compare root and child usage components with the
  runtime rollouts: each child appears once and excludes copied parent-prefix usage. Resume the
  same thread with "Read one.txt and report its word without delegation." Pass: footer/ledger
  charge that message's delta, never the previous root turn or children again. Keep screenshots,
  provider session ids and a redacted usage comparison as evidence.
- [ ] Live Claude regression: in a separate disposable QA thread pinned to Claude with the same
  two-file fixture, send the same two-agent prompt and then the same no-delegation resume prompt.
  Pass: both native children remain visible and finish; result words and resume accounting match
  native engine evidence. No Codex reducer should run in the Claude-only path.
- [ ] Live failure fixture: on an isolated test daemon, make only `inspectUsage` reject (do not
  change HOME permissions/production config). Fresh Codex work still replies and shows one
  incomplete-accounting notice; a resumed turn fails before engine spawn. Remove the injected
  failure and retry: it proceeds, proving no held session lock. This is Codex-specific because
  Claude never invokes this reader.

Automated helper/runner checks do not certify actual Podman namespace permissions, authenticated
provider events, or Slack rendering. Those live cases and private QA registration remain release
acceptance gates; no production restart or external message was performed by the implementation.

- [x] Native schema check (2026-09-07): authenticated Codex CLI 0.153.4 / `gpt-6-astra`
  in the existing channel container spawned synthetic `alpha_checker` and `beta_checker`, joined
  both and returned `alpha`/`beta`. The reducer recovered both names, exact request accounting,
  15,219 tokens per child and elapsed times of 4,196 / 4,424 ms. This exercises real provider
  rollouts, but does **not** mark the separate host-rootless/Slack acceptance above passed.
- [x] Full suite with isolated HOME/TMPDIR and `--test-concurrency=4`: 2,122 passed, 0 failed,
  2 live cases skipped; coverage lines 92.66%, branches 82.43%, functions 87.44%. Static, secret
  scan and DCO checks passed. Default `/tmp` in the development container is private (0700),
  causing the unrelated service-path preflight fixture to fail on unchanged main too; the
  isolated run uses public ancestors without modifying container/production permissions.


### Personal Codex skill catalog delivery — REL-SKILLS-01 (2026-09-07)

- [x] Automated: `node --test test/run-grant-isolation.test.js test/codex-args.test.js
  test/codex-message-to-reply-e2e.test.js`. Two concurrent authors get only their own catalog
  paths, copied support files and cleanup; shared project skills are unchanged. Fresh/resumed
  prompts include the current catalog, empty catalogs supersede previous grants, clean prompts
  omit it, and the persistent HOME/CODEX_HOME remain unchanged. An absent selected personal
  skill throws a named error before engine launch instead of silently delivering an empty list.
- [ ] Live Codex, ordinary read mode: in a disposable QA channel grant `shared-proof` to the
  channel and `personal-proof` only to author A. Shared SKILL.md says return SHARED-COPPER-18;
  personal SKILL.md requires reading its `references/word.txt`, containing PERSONAL-COBALT-73.
  Ask A: "Use shared-proof and personal-proof and report both fixture words." Pass: both words
  are correct, the personal SKILL.md/reference are actually read, HOME/CODEX_HOME stay the
  persistent channel paths, and no personal file appears in project .agents/skills. Native
  read-only shell remains available for reading the artifact; the workspace-scoped gateway
  reader is not widened. Repeat as author B with no personal grant: no personal catalog entry.
- [ ] Live Codex resume: rotate A's personal reference to PERSONAL-AMBER-29 and repeat in the same
  provider thread after prior artifacts have been removed. Pass: the new skill/reference path is
  read and the new word returned; auth/session roots remain unchanged. Remove the grant and
  repeat: the current catalog is empty. Clean mode must not inject the catalog.
- [ ] Live Claude regression: use the same author/channel fixture on Claude; native personal
  plugin loading, reference reading and per-run cleanup must still work. A missing selected
  personal skill fails by name on both engines.

- [x] Native provider probe (2026-09-07, Codex 0.153.4, gpt-6-astra/high): a synthetic personal
  catalog pointed outside the disposable cwd to SKILL.md and references/proof.txt. With the
  gateway's read-only sandbox and `features.use_legacy_landlock=true`, the real engine read
  both files successfully and returned the exact marker CG_PERSONAL_REFERENCE_OK_7319. The
  fixture was removed. This verifies catalog/reference readability in an existing container;
  the deployed author-grant, resume/revocation and Slack cases above remain unexecuted.
