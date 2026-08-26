# ChannelGate — Test Plan

Cumulative functional + security regression. Extended per slice. Run top-to-bottom for a full
pass. Many checks are manual (require a real Slack workspace + an authenticated `claude` CLI).

## Chat-platform adapter kernel (multi-platform seam)

Automated: `test/platforms.test.js` (30 checks). Existing `test/format.test.js` (45) is the
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

## Engine adapter kernel (Phase C)

- [x] Register adapters only when manifest, confinement, runner, interrupt, discovery, and health validate.
- [x] Reject unknown engines, invalid origins/principals, unsupported network policy, and incomplete
  selected Codex MCP definitions.
- [x] Prove a fake third adapter exports UI metadata without orchestrator, route, or wizard edits.
- [x] Verify complete safe Codex stdio/HTTP MCP serialization and reject credentials/userinfo.
- [x] Run the full local suite and static parser/whitespace gate.

## OpenCode proof adapter (Phase D)

- [x] Registry/UI manifest exposes OpenCode through the existing adapter-driven selectors and
      health matrix; no OpenCode branch is added to the run orchestrator, routes, or model wizard.
- [x] Admission compiler accepts only read-only + network-off and rejects write, approved-domain
      network, admin bypass, selected MCPs, and unknown capabilities before spawn.
- [x] Spawn contract uses `--pure`, raw JSON output, the dedicated default-deny agent, an inline
      deny policy for shell/edit/web/subagent/LSP/execute/external-directory, and no MCP transport.
- [x] Portable stub E2E covers new session, emitted session identity, resume, streamed text,
      tokens, reported cost, health/version-compatible CLI shape, and AbortSignal process-group
      cancellation on macOS/Linux.
- [ ] Live/manual: on both macOS and Linux with a low-privilege provider account, confirm a normal
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
- [x] `npm run check:static`: every tracked JavaScript source/test/script parses under the supported
      Node runtime and fails on tabs or trailing whitespace. This is the deliberately incremental,
      dependency-free static/format gate; repo-wide ESLint/typed-JS adoption remains a future
      ratchet rather than a permanently red flag-day check.
- [x] `npm run test:coverage`: full-suite coverage floors remain 67% lines / 67% branches / 66%
      functions on macOS and Linux at Node 22.13 and 24.
- [x] `npm run test:security-coverage`: independent floors prevent unrelated code from masking
      regressions in authorization (95/95/95), access grants and engine-scope isolation
      (95/75/70), sandbox policy (90/90/80), secrets (90/80/65), and transactional updater state
      (75/65/75). Values are lines/branches/functions and may only ratchet upward.
- [x] `test/codex-message-to-reply-e2e.test.js`: a stub Codex binary drives an authorized Slack DM
      through message→reply, persists the returned session, uses `exec resume` on the follow-up,
      receives the gateway MCP registration, and terminates on cancellation.
- [x] Nightly compatibility: macOS + Linux install pinned `@anthropic-ai/claude-code@2.1.220`
      and `@openai/codex@0.144.1` targets, probe every provider-free CLI flag the adapters depend
      on, then run each engine's adapter/stub message-to-reply regression. Action revisions and CLI
      versions are immutable in the workflow.
- [ ] Nightly authenticated turn: message→reply against the live Claude and Codex providers is
      intentionally not automated until CI has isolated low-privilege provider credentials and a
      zero-retention test workspace. The deterministic harness tests do not claim provider parity.
- [ ] Live confinement canary (macOS + Linux): from read and worker profiles, attempt reads/writes
      outside the channel root, credential/env extraction, network access with policy off, gateway
      state mutation, and cross-channel Slack List access. Existing unit suites verify generated
      policy and escape-path denials; this OS-level adversarial run remains a release/manual gate.

## Functional checks

### Phase F operational readiness

- [x] `test/license.test.js`: `LICENSE.md`, `docs/LICENSING-DECISION.md`, `package.json`, and README
      consistently identify the Makeitfuture Sustainable Use License as source-available/fair-code
      rather than OSI open source; `THIRD_PARTY_NOTICES.md` and `public/fonts/OFL.txt` preserve
      Poppins' OFL terms.
- [x] `test/license.test.js` (v1.2 case, replaces the v1.1 case 2026-08-25): the license is stamped
      `Version 1.2` and names ChannelGate (formerly Claude Gateway for Slack) with the author line;
      §3.1 keeps the dedicated-deployment conditions, adds the customer's-key condition, and permits
      any number of separate deployments without an agreement; §3.2 defines license keys (no key →
      one conversation), end-user keys, no sharing/pooling, no reduction of an enterprise key's
      limits in term; §4.5 forbids circumventing verification, limits, or reporting; §4 names the
      Reseller, White-Label, Enterprise, and optional Partner agreements; §5 defers to
      `TRADEMARK.md`, which states nominative use and the no-own-product-name rule; §6 points at
      `CLA.md` 1.1 (relicensing grant, copyright stays, `Signed-off-by`, no automatic relicensing
      promised); `AUTHORS.md` records the author and the IP assignment and the decision record is
      the pre-CLA acceptance; §11 sets Romanian law and Bucharest venue. **Control:** no public text
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
- [x] Linux systemd packaging asserts a dedicated non-login identity and hardening boundaries;
      launchd packaging asserts background throttling and private runtime/log permissions.
- [x] Release artifact generation emits CycloneDX SBOM, in-toto/SLSA-shaped provenance, and SHA-256
      checksums; tag workflow retains evidence as an immutable workflow artifact.
- [ ] Operator canaries: clean-machine install/uninstall on current macOS + Linux, 24-hour Slack and
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
- [x] The demo block is a placeholder: the HTML comment and the `docs/assets/demo.gif` note exist
      and no stand-in GIF is committed; `docs/assets/README.md` documents both expected assets.
- [x] `.github/REPO-METADATA.md` has an About text ≤ 350 characters, the website URL, all ten
      topics in a `gh repo edit` command whose `--description` matches the About text, and the
      1280 × 640 social-preview spec.

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
      note plus a continuation turn presenting the agent's report. Daemon restart mid-agent-job →
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
- [ ] Provisioning: fresh setup on macOS and Linux verifies both choices. Yes installs/reuses pinned
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
- [ ] Slack shows progress then the final answer with a token/cost line.
- [ ] Native Slack streaming: on a routine turn, the reply is written live
      (chat.startStream/appendStream), the footer appears as a block at stopStream, and no extra
      task-card/activity-log/Plan messages are posted; exactly one answer message appears (no
      duplicate final post). Falls back to a plain reply if streaming errors.
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
- [x] Unit: a run beyond five minutes emits completed heartbeat pulses every 20 seconds and rotates
      task IDs before Slack's five-minute threshold; finish, stop, and failure paths relabel the
      newest pulse, abrupt restart leaves no open row, and recaps exclude every heartbeat generation
      (`test/slack-progress.test.js`).
- [x] Unit: message-level native-stream rollover starts its age clock only after Slack creates the
      message; a long pre-answer card rolls repeatedly before five minutes and seeds each successor
      with the full completed/live toolbox; a long answer copies its exact compiled Markdown into
      the successor before deleting the retired bot message. Cleanup failure keeps both safe copies,
      successor-seed failure delivers the complete classic fallback, and final delivery closes only
      the newest healthy stream (`test/slack-progress.test.js`).
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
      once, and terminal intake ignores late snapshots
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
      thread (setStatus accepted) retains terminal tool rows and the recap in its finalized answer
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
- [ ] Live: in an auto channel, `run_in_background` posts a "Background shell job (unsandboxed)"
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
      PATH but a valid configured absolute path → present; on + missing → install (brew/macOS,
      official installer/Linux, best-effort, never aborts the update); no settings file → skip.
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
- [ ] Live: start a thread in a Codex channel, flip the channel to Claude → the thread's next
      message still runs Codex and keeps its conversation; a brand-new thread runs Claude;
      `@bot claude …` in the old thread switches it (fresh session + thread-context replay).
- [x] Unit: gateway default model — unset → "" (CLI default) for both engines; per-engine values
      round-trip through saveSettings + settingsForApi; values are trimmed, non-strings ignored,
      blank clears; the admin-route `isValidModel` guard accepts known ids and rejects garbage.
- [x] Unit: an explicit pre-output/pre-tool Codex model rejection retries once with a distinct
      gateway default, updates runtime/model reporting, and labels the reply. Generic failures and
      post-tool model errors never replay; if the default also fails, the original error is kept.
- [ ] Live: with no channel model set and a gateway default of `sonnet`, a run's `--model` is
      `sonnet` even after the admin's terminal `/model` picks a different model; a channel/thread
      `/model` override still wins; Codex-fallback turns use the Codex default, not the Claude one.
- [x] Unit: the `/model` wizard's model and effort steps emit buttons only (no `static_select`, no
      section accessory) — one button per curated option, unique indexed `action_id`s that the
      registered picker patterns match, ≤25 elements per actions block, wizard scope/thread/value
      encoded in every button value, exactly one button marked ✓ + primary (the "Gateway/Engine
      default" entry when nothing is overridden), and the patterns still match the retired bare
      `cg_model_pick` / `cg_effort_pick` select ids.
- [x] Unit: admin-UI model dropdowns (Settings defaults, channel Runtime card, channel/DM config
      editors) list the wizard's curated options for the selected/inherited engine; a saved
      non-curated same-engine id shows as an extra option and stays selected; switching the engine
      swaps the list and drops the other engine's pick to blank. Fable 5 (`claude-fable-5`) appears
      only in the Claude list and never in GPT/Codex choices.
- [x] Unit/integration: Settings' confirmed channel-runtime reset is admin-authenticated, clears
      only `engine` + `model` for every channel (including a never-configured channel), skips DMs,
      preserves effort/access/skills/credentials, refreshes the conversation cache, and reports
      the affected count (`test/channel-runtime-reset.test.js`).
- [ ] Cross-engine failover, both directions: with failover ON, a usage-limit response or pre-tool
      authentication failure answers via the OTHER harness with a reason note and observes its
      per-engine per-channel / gateway-wide ~15-min cooldown; with failover OFF, the engine's own
      error surfaces. A post-tool failure never replays.
- [x] Unit: the Codex runner classifies its plan-limit rejection ("purchase more credits…") as a
      replay-safe `usage_limit` — as a JSON error event AND on stderr with a nonzero exit — while
      model rejections keep routing to the same-engine model retry and ordinary
      provider/connection errors stay unclassified (`test/engine-failover.test.js`).
- [x] Integration: a channel whose PRIMARY harness is Codex hits its usage limit and the turn is
      answered by Claude (reason note, thread transcript replayed into the fresh session,
      `fellBack`/`fallbackFrom` set); the same limit on stderr behaves identically; a limit that
      lands after a tool ran is NOT replayed; failover OFF and a disabled target harness both leave
      the error surfaced (`test/codex-failover-e2e.test.js`).
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
- [ ] Codex sandbox mirrors mode: read-mode channel → Codex write is refused; bash/auto → write works;
      approved-domain requests reach listed public hosts and refuse unlisted/local/private hosts
      (including Claude→Codex fallback); admin foreground Full access is labeled unrestricted.
- [x] Unit: semantic network compiler maps off/approved/unrestricted intent identically for Claude
      and Codex, normalizes/deduplicates public DNS patterns, refuses empty/global/local/IP/URL-shaped
      lists, and keeps explicit admin bypass unrestricted. Slack/admin capability labels expose the
      same boundary (`test/network-domains.test.js`, `test/network-policy.test.js`, `test/modes.test.js`,
      admin shell assertions).
- [x] Unit: non-Full Codex argv (fresh, resumed, clean, network-enabled) emits `--ignore-user-config`
      plus the Gateway-owned permission profile (`default_permissions` + `permissions.gateway-readonly`
      / `permissions.gateway-workspace` extending `:read-only` with `:root` denied), and NEVER emits
      `-s`, `sandbox_mode`, `sandbox_workspace_write.*`, or a filesystem grant on the gateway runtime
      root; full access keeps the bypass flag and no restricted profile; the child TMPDIR points at
      the private per-run scratch dir for sandboxed runs only.
- [x] Live (macOS seatbelt, codex-cli 0.144.1): `codex sandbox` probes — readonly profile reads the
      workspace but not `~/.channelgate`, home, or a sibling folder, and cannot write the
      workspace; workspace profile writes the workspace + its TMPDIR scratch only (`.git` write
      denied, sibling/gateway/home reads+writes denied; a sibling run's scratch dir under the gateway
      root is unreadable). Real restricted `codex exec` run: outside reads denied, workspace write
      succeeds, the embedded gateway MCP `list_schedules` tool works with zero filesystem grants, and
      the scratch dir is removed at completion. Documented carve-out: `:minimal` keeps shared `/tmp`
      read+write open regardless of denies (platform behavior — nothing sensitive is placed there).
- [x] Live (macOS, codex-cli 0.144.1): the production-shaped permission profile with
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
- [ ] admin-mode escalation needs BOTH: admin author + adminMode channel → sandbox off; a non-admin in
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

### Sandbox boundaries (bash / network)
- [ ] Bash channel: write inside the folder works; writing `~/.ssh`, `~/.aws`, the gateway root, or a
      sibling channel folder is denied; reading the home root / gateway root is denied.
- [ ] Network off by default; allow-network + allow-bash → `gh`/`git push` succeed, a non-allowlisted
      domain fails.

### In-thread commands & stop
- [ ] `/context` shows tokens + % of the context window from the last turn.
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
      file browsing, Composio and Skills Manager setup, memory/rules, automatic gateway skills,
      reminders/schedules, durable background work, `/status`, and `/pending`; it distinguishes a
      thread's `stop`/🛑 from the top-level `/stop` sweep.
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
- [ ] Stopped-request replay: stopping request 1 in a thread does not create replay context; stopping
      request 2+ records only that stopped user request, then the next message in the same Slack
      thread consumes it once before the current message.
- [ ] Busy-thread choice: send a second message while a turn is actively generating → the message
      does not run or alter sticky thread settings yet; a card offers *Steer Conversation*,
      *Add to Queue*, and *Cancel Request*. Only its author can use it, only the first valid click runs the message, and
      an expired/replayed click explains that the message must be sent again. Restart the daemon
      before clicking: the card still works and is not auto-run by boot recovery.
- [ ] Redelivered message never raises a card: while a long turn runs, kill the daemon so Slack
      redelivers the unacked message envelope. On boot, recovery replays that message and the
      redelivered copy is dropped silently — no steer/queue card appears for a message nobody
      re-sent, and the thread is answered exactly once (either recovery or the copy owns it, never
      both). A genuinely new message sent after the restart still gets its card.
- [ ] Steer Conversation: choose it during a warm Claude turn, a cold Claude turn, and a Codex turn.
      The active turn stops quietly without dumping half-finished output or a false error, the chosen
      message runs next, and an immediate daemon restart cannot replay the intentionally abandoned
      turn alongside its successor. Restart recovery aborts quietly if it was the active owner. A
      different author's choice queues instead of interrupting the active owner's work.
- [ ] Add to Queue: choose it while any engine runs → the active process is not interrupted and the
      selected message runs FIFO after it. `stop` invalidates unresolved choice cards and aborts the
      active engine before awaiting Slack acknowledgements. `/next <task>` remains the direct
      no-click queue shortcut.
- [ ] Cancel Request: choose it while a turn runs → the paused message never runs, the card is
      replaced by a cancelled notice, the active run keeps going to completion, and clicking the
      retired button again (or after a daemon restart) reports the choice as already used.
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
- [x] Unit (`test/file-editor.test.js`): a browser edit button supports eligible files beyond the
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
- [ ] In Worker/Auto mode, *Edit in browser* opens the public gateway editor in a new browser window,
      with full content and a live split preview for Markdown; Save changes the confined file and
      `channel_file_edited_in_browser` is audited. Read-only hides Edit; Full allows only an admin.
      Reusing/forwarding an already-opened link, leaving the channel, losing authorization/mode, or
      changing the file after opening refuses access/save and leaves the latest disk version intact.
- [ ] Remove the configured public URL → eligible files ≤3,000 characters fall back to the Slack
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
      Atlas mention/member ID, approved Make bot user, trusted Make app/bot IDs, both apps in the
      channel, and root `thread_ts` fallback.
- [ ] Live: export the Make module and confirm `mapper.text` begins with `<@U0BAQFWHNAK>`; post it
      through the approved/trusted Integromat bot and verify Atlas replies in the original root
      thread when the source event is either a channel message or a threaded reply.
- [ ] Set a channel's working folder to a real project via the picker → the run happens there and an
      existing `CLAUDE.md`/`AGENTS.md` is not overwritten; clearing it reverts to `~/ChannelGate/<platform>/<slug>`.

### Admin UI
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
- [x] Budget: with a small `meta.memoryBudget`, an over-budget batch FAILS with "consolidate in the
      SAME call" advice and leaves BOTH the index and any topic file in the batch untouched; the
      same add fits when the batch also removes/replaces stale lines (`test/channel-memory.test.js`).
- [x] Batch semantics: `add` lands inside its named `section` (case-insensitive) or at the end;
      an exact duplicate add is a no-op with a note; `replace` swaps the whole line and rejects a
      substring matching two lines; headers/seed note are never replace/remove targets;
      instruction-shaped (`ignore previous instructions`, `[system]`), token-shaped (`xoxb-…`)
      and invisible-Unicode content is refused before any write (`test/channel-memory.test.js`).
- [x] Snapshot injection: a fresh session's prompt starts with `[Channel memory — snapshot at
      session start; index N% of its 8000-char budget …]` + the index + the topic-file list, and
      ends with `[End of channel memory.]`; nothing is injected for an empty index, a clean run,
      or memory off; an over-budget hand-edited index is trimmed at 1.5× budget and an embedded
      copy of the sentinel is neutralized (`test/channel-memory.test.js`).
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
- [ ] Admin UI Memory tab reflects the index model: hint shows the budget meter ("index N% of
      budget") and lists `memory/<topic>.md` files; saving an over-budget index is allowed but
      flagged "saved — over budget"; the meter refreshes after save.
- [ ] Overview is the default landing view: 5 KPI tiles (Est. API value in orange, Runs with avg value,
      Active users, live Active sessions, Tokens with in/out sub), the orange hero cost chart
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
- [ ] Overview **range dropdown** (Today / Last 7 days / Last 30 days / This month / Last month /      This year / Last year) reloads on change and re-scopes every tile + chart. Bucket granularity
      adapts: Today = hourly points, week/month = daily, year = monthly; empty ranges (e.g. Last year
      with no data) render zeros/flat without error.
- [ ] `GET /api/dashboard?range=…` returns `{ range, unit, start, end, totals, series (gap-filled,
      one point per bucket), byUser, byChannel }`; an unknown range falls back to `last30`.
- [ ] Settings: vertical section nav (Connection / Agent defaults / Integrations / Access &
      security / System); every section stays in the DOM and ONE sticky Save persists all of them;
      dirty tracking shows "Unsaved changes" on any edit and "All changes saved" after save/boot.
- [ ] Token fields (Slack bot/app/signing, org-default Composio/Skills/Toolbox, per-channel and
      per-user) pre-fill the stored token masked (first few + last 4) with an eye toggle that reveals
      the full value; leaving a field untouched and saving keeps the stored token; typing a new one
      overwrites it. Slack reconnect fires only when a Slack token is actually changed.
- [ ] A DM using the User/Admin template reflects the template's config; editing the template applies
      across DMs; a per-DM custom config overrides.
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
      badge, status dots all render identically on macOS + Linux browsers.
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
- [ ] Users: table rows show role chips, C/S/T token state and Slack identity; clicking a row opens
      the edit drawer; Save from the drawer persists name/approved/admin/tokens (unchanged PUT) and
      the drawer stays on that user; "+ Add user" reveals the add form; adding opens the new user.
- [ ] Settings danger zone: Reset all channels' access / Remove password / Restart daemon /
      Disconnect Slack live in the red zone; each opens the branded confirm dialog (danger-tinted
      confirm button, Escape cancels, backdrop cancels); reset completion shows an in-app notice
      (no native confirm()/alert() anywhere).
- [ ] Settings chip editors (trusted bot apps, network egress domains): Enter/comma adds a chip,
      × removes, Backspace on empty removes last; saving persists the same comma-separated values
      as before the redesign.
- [ ] Automations (was Schedules): rows show mono cron chip, "invalid" warn badge when the cron is
      bad, last-run status dot (green ok / amber warn), enable + notify autosaves flash "saved",
      Delete confirms via the branded dialog.
- [ ] Click the non-control area of an automation row: a detail modal opens with channel, timing,
      task type, last-run status, notification target, description, and the full saved prompt.
      Press Enter/Space on the row's details button to verify the same keyboard path; then use
      Cancel, ✕, Escape, and the backdrop and confirm each closes without saving. Checkbox,
      notification, person-ID, and Delete interactions must not open the modal.
- [ ] Edit an automation prompt to multiline text and save: the modal closes, a hard reload shows
      the exact saved text, and the next execution uses it. A whitespace-only prompt is refused;
      simulate a failed PUT and confirm the error stays visible with the draft intact while Save
      leaves cron, description, notification settings, enabled state, and last-run data unchanged.
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

### Scheduling & reminders — acknowledgment + escalation (Slice 8.9)
- [ ] `create_schedule kind:"reminder"` posts ONE "⏰ Reminder:" message (no "Running:" announce,
      no Claude run / token footer).
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

## CLI integrations (2026-08-19)

- [x] Every catalog entry's domains pass the shared network-domain normalizer; credential paths
      are HOME-relative and cannot escape upward (automated: `test/cli-integrations.test.js`).
- [x] Enabling an integration merges its domains into the EFFECTIVE list only — the stored
      `networkDomains` base value the UI round-trips is untouched; unknown ids are dropped on read
      and on save (automated).
- [x] Bash+network sandbox gains the integration's domains and read-ONLY credential paths; the
      same paths are never writable, absent with network off, and absent when the integration is
      disabled (git/gh baseline only) (automated).
- [x] Admin-run settings variant of a no-Bash admin+network channel includes the credential read
      re-allows; the shared variant of the same channel does not (automated).
- [ ] Manual: with Vercel enabled in Settings, a Bash+network channel runs `vercel deploy` from
      its working folder in-sandbox (no unsandboxed-shell approval card); with the integration
      disabled the same command fails on a network/credential denial instead of leaking.
- [ ] Manual: in an admin-mode, Bash-off, network-on channel, an admin author's `git push` over
      HTTPS authenticates; a non-admin author in the same channel still cannot read `~/.gitconfig`.
- [x] `normalizeRequestedDomain` accepts bare domains / wildcards / URLs (hostname only) and
      refuses IPs, localhost, single-label hosts; stored channel extras degrade to NO extras on
      any malformed entry; extras join only that channel's sandbox list (automated).
- [ ] Manual: `request_network_domain` posts an Approve/Deny card any authorized user can approve;
      the domain lands in the channel card's "Extra network domains" field, works on the next
      message, and deleting it there revokes access. An invalid or already-allowed domain gets a
      refusal/no-op with NO card.
- [x] CLI install detection: every catalog id reported; API-only entries are `null` (no badge),
      binary entries boolean; a binary appearing in a searched dir flips to installed; the TTL
      cache holds between calls and clears on reset (automated: `test/cli-detect.test.js`).
- [ ] Manual: Settings → CLI integrations shows "installed" on Vercel (present on this machine)
      and "not installed" on Supabase; Make.com carries no badge.
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
- [ ] Manual (Linux, per-user toolchain): in a Bash channel whose node lives under `~/.local/bin`,
      `node --version`, `npm --version`, `npx --version` and (Vercel enabled) `vercel --version`
      all resolve inside the sandbox; with the grant removed each reports `command not found`.
      Verified 2026-08-26 against a real `claude -p` sandbox run on the Linux host.

## Security checks
- [ ] **Filesystem confinement:** inside a channel folder, `claude` cannot read/write outside it
      (attempt to read `~/.ssh` or a sibling channel folder is blocked by the sandbox).
- [ ] **MCP allowlist:** `claude mcp list` inside a channel folder shows ONLY the channel's
      allowed servers + the injected personal/shared Composio identities (per the run); nothing else.
- [ ] **Memory off:** no writes to `~/.claude/projects/<cwd>/memory/` for channel folders.
- [ ] **Composio isolation:** user A's `composio-user` token is never used for user B; shared
      `composio-agent` remains distinct; no tokens are written to channel `settings.json` or logs.
- [ ] **Dangerous perms:** `--dangerously-skip-permissions` only ever passed for admin authors.
- [ ] **Admin sandbox-off:** in an admin-mode channel, an admin's LIVE foreground turn can read a
      file outside the channel folder (e.g. `~/.config/...`) — the admin settings variant has
      `sandbox.enabled: false`; the shared variant keeps `enabled: true` and a non-admin (or any
      background/schedule/continuation run) still cannot read outside the folder.
- [ ] **Background gating:** `run_in_background` is refused in a plain `allowBash` channel. Auto mode
      requires a gateway admin's durable exact-command approval; Admin mode skips the second card
      only for an admin author. Restart/replayed clicks cannot reuse Auto-mode authorization.
- [ ] **Internal IPC:** `POST /internal/background` returns 403 without the per-process secret.
- [ ] **Secrets:** `.env` and `~/.channelgate/config/users.json` are gitignored; tokens never
      appear in logs or Slack messages.
- [ ] **Linux userns sandbox:** on an Ubuntu 23.10+ host, `sudo sh scripts/apparmor/claude-userns-fix.sh
      --check` reports `RESULT: host OK` (after `--apply` if needed); a sandboxed `claude -p "run:
      echo ok"` in a folder with `{"sandbox":{"enabled":true}}` prints `ok`; with the profile removed
      the daemon logs `[gateway] WARNING: AppArmor restricts unprivileged user namespaces …` at boot.
      Unit: `test/linux-userns.test.js` (verdicts for restricted/no-profile, profile installed, knob
      absent, Debian hard-off, macOS).

## Review remediation (2026-07, IMPROVEMENTS.md)
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
### Transactional self-update

- [x] Unit: exclusive reservation, live-owner refusal, dead/abandoned-owner recovery, ownership
      checks, atomic state transitions, terminal idempotency, and strict non-secret public status.
- [x] Unit: isolated Claude smoke creates a temporary gated folder with memory/dreaming off,
      sandbox on, no network/MCP/bypass, a fixed exact response, bounded timeouts, and unconditional
      cleanup. Internal route requires loopback plus the daemon secret.
- [x] Unit: disk sizing covers dependency/recovery staging plus explicit missing-Whisper space;
      high/critical audit counts block while moderate counts are preserved; readiness requires a
      replacement instance on the expected boot revision, Claude, and prior Slack connectivity.
- [x] Unit: successful candidate phases, preflight refusal before mutation, post-checkout rollback,
      rollback failure, targeted systemd `MainPID`, launchd support, wrapper/provisioning contracts,
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
- [x] Unit (2026-08-25): service probes are platform-derived — launchd only on darwin, BOTH systemd
      scopes (system, then `--user`) on linux, both managers on anything else; the refusal names
      only managers that can exist on the host, and the detected scope rides on the service record
      so the restart asks `systemctl` in the same scope. → `update-runner.test.js`.
- [ ] **Service portability:** repeat candidate success and rollback on macOS launchd and Linux
      systemd, including a Linux box whose daemon is a USER unit at
      `~/.config/systemd/user/channelgate.service`. Systemd signals only the validated positive
      `MainPID`; launchd uses `kickstart -k` with the existing installer fallback.

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
- [ ] Live drill (macOS + Linux, on a scratch HOME): seed a pre-rename install, run
      `node scripts/migrate-channelgate.mjs --dry-run`, review the plan, then boot the daemon and
      confirm zero lost channels/memory/schedules, a regenerated sandbox per channel, and that
      `npm run service:install` / `sudo bash scripts/install-systemd.sh` leave exactly ONE service
      registered under the new name.
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
- [x] Unit (migration): the installed systemd user unit and launchd plist have their runtime-root
      paths rewritten while an unrelated `WorkingDirectory` is left alone, and a
      `service-reload-required.json` marker is written for the updater
      (`test/migrate-channelgate.test.js`).
- [x] Unit: `applyPendingServiceReload()` consumes that marker exactly once — `daemon-reload` before
      the systemd restart signal, `bootout` + `bootstrap` INSTEAD of a kickstart on launchd (a
      kickstart re-runs the old plist), reporting `restarted` so the caller does not restart twice
      (`test/update-runner.test.js` seam, `test/migrate-channelgate.test.js`).
- [x] Unit: `--verify` / `auditLegacyPaths()` names every store on a fresh fixture (project
      directories, transcripts, Codex state, work-folder text, config JSON), and reports 0 after a
      real run; `formatAudit` prints the roots it scanned and the total
      (`test/migrate-channelgate.test.js`).
- [x] Unit: a dry run renames no project directory, leaves the Codex index and `config.toml`
      untouched, and still ends with the pre-migration audit plus a "would leave N occurrence(s)"
      line (`test/migrate-channelgate.test.js`).
- [ ] Live: `node scripts/migrate-channelgate.mjs --verify` against the production install
      (read-only) enumerates every store; re-run it after the real migration and require 0.
