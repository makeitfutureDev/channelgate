# Installing ChannelGate on a new machine

A step-by-step guide to get the gateway running on a fresh macOS or Linux host. For what it does
and how it works, see [README.md](./README.md).

## 1. Prerequisites

- **macOS or Linux** (the bundled autostart service uses macOS `launchd`; Linux can run the daemon
  manually or under its normal service manager).
- **Node.js ≥ 22.13** — `node -v` (the gateway's SQLite store uses the built-in `node:sqlite`,
  stable from 22.13). Install from <https://nodejs.org> or `brew install node`.
- **Claude Code CLI**, installed and authenticated — the gateway spawns it directly:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude login          # or set ANTHROPIC_API_KEY
  claude --version      # must work
  ```
- **(Optional) OpenAI Codex CLI** — only if you'll use the Codex engine:
  ```bash
  npm install -g @openai/codex
  codex login           # or set OPENAI_API_KEY
  ```
- **(Optional, Linux only) rootless Podman** — only if you'll run channels in their own containers
  instead of the host sandbox: `sudo apt install podman uidmap`, confirm the daemon user has
  `/etc/subuid` + `/etc/subgid` ranges, then build the channel image with `npm run build:image`.
  Setup, settings and caveats are in
  [`docs/OPERATIONS.md`](./docs/OPERATIONS.md#container-runtime).
- A **Slack workspace** where you can create an app.

## 2. Get the code

```bash
git clone https://github.com/makeitfutureDev/channelgate.git
cd channelgate
```

## 3. Run the installer

```bash
npm run setup
```

This checks Node/CLI prerequisites, installs dependencies, asks whether to provision pinned
`whisper.cpp` plus the multilingual `large-v3-turbo` model, creates `.env`, and (on macOS) installs
the **launchd** service so the gateway starts on login and restarts on crash. Choosing Whisper
downloads about 1.5 GiB. On macOS the installer uses Homebrew for missing `ffmpeg`/`cmake`; on Linux
it uses the available package manager when permitted, or explains which prerequisite is missing.

The runtime and model are reused on subsequent setup/update runs. A no-Whisper install skips them
on later updates too. For unattended installs, make the choice explicit:

```bash
npm run setup -- --with-whisper
npm run setup -- --without-whisper
```

`CG_INSTALL_WHISPER=yes|no` is the equivalent automation setting. To provision or repair the local
assets independently:

```bash
npm run whisper:install
```

- To skip the autostart service: `npm run setup -- --no-service` (then run `npm start` yourself).
- Manage the service later: `npm run service:install` / `npm run service:uninstall`, or
  `launchctl kickstart -k gui/$(id -u)/com.makeitfuture.channelgate` to restart it.

#### Starting at boot instead of at login (macOS)

The default macOS install is a **LaunchAgent**, and a LaunchAgent's domain only exists while its
user is logged in graphically. After an unattended restart the Mac sits at the login window and the
gateway never starts — Slack goes quiet and the admin UI is unreachable until somebody signs in.

To load it at boot instead, install the **LaunchDaemon** variant:

```bash
npm run service:install:boot     # = sudo bash scripts/install-launchd.sh --boot
```

It writes `/Library/LaunchDaemons/com.makeitfuture.channelgate.plist` (root-owned, 0644) and
still runs the daemon as *you* via `UserName`, since the engine credentials, runtime root and
channel folders all live in your home. It removes the LaunchAgent as it goes: the daemon takes a
singleton lock on the runtime root, so two copies can never run — the loser exits with
`EALREADYRUNNING` and `KeepAlive` turns that into a crash loop.

Two limits worth knowing before you rely on it:

- **FileVault.** On a cold unattended reboot (power cut, panic) the Mac halts at the preboot unlock
  screen, where nothing runs at all — no daemons, no SSH. Boot mode covers *"disk unlocked, nobody
  logged in"*, not *"nobody touched the Mac"*. For a planned restart that comes back on its own, use
  `sudo fdesetup authrestart`.
- **No GUI session.** The login keychain stays locked. The engine CLIs read
  `~/.claude/.credentials.json` so they authenticate fine, but anything reading a secret from
  Keychain, and any GUI/browser automation, will not work.

Revert to login-time start with `npm run service:uninstall:boot` followed by `npm run
service:install`.

The admin UI + health endpoint come up on <http://localhost:4747> (set `PORT` in `.env` to change).

### Safe updates

Run `npm run update`, use the dashboard Update button, or ask an admin to use Slack `/update`.
The updater requires an active launchd service on macOS or `channelgate.service` under systemd
on Linux so it can prove both candidate and rollback restarts.

Before changing Git it checks upstream access, a clean fast-forward-only checkout, Node/npm,
settings, service state, free space, current gateway health, and an isolated Claude turn. Base
staging requires 1 GiB free. If local Whisper is enabled but its 1.5 GiB model is missing, the
calculated requirement becomes 3 GiB on Linux or 4 GiB on macOS; disabling local Whisper makes the
large optional download explicit and skips it.

The candidate runs `npm ci`, the production advisory gate, the full test suite, and provisioning
before restart. It is accepted only after the replacement reports the expected revision, Claude is
available, Slack reconnects when previously connected, and a second isolated Claude turn succeeds.
A post-change failure automatically restores the prior revision and dependencies and verifies that
restored build. See `~/.channelgate/logs/update.log` and
`~/.channelgate/update-state.json`; operator recovery snapshots are saved under
`~/.channelgate/update-backups/`.

## 4. Create the Slack app (from the manifest)

1. Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest**.
2. Pick your workspace, paste the contents of [`slack-app-manifest.json`](./slack-app-manifest.json),
   and create. It preconfigures Socket Mode, all scopes, events, the Assistant feature, and the
   `/stop` and `/files` commands plus the *Browse channel files* message shortcut.
3. **Basic Information → App-Level Tokens** → generate a token with `connections:write`
   → this is `SLACK_APP_TOKEN` (`xapp-…`).
4. **Install App** → install to the workspace → copy the **Bot User OAuth Token**
   → `SLACK_BOT_TOKEN` (`xoxb-…`).
5. **Basic Information** → copy the **Signing Secret** → `SLACK_SIGNING_SECRET`.

## 5. Configure tokens

Open <http://localhost:4747> → **Settings** tab → paste the three Slack tokens →
**Save & connect**. The status banner should turn green (`● Connected as @… in …`).

(Alternatively, put `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` / `SLACK_SIGNING_SECRET` in `.env` and
restart — but the UI is easier, and UI settings override `.env`.)

### License key

A fresh install serves **one conversation** (channel, DM, or group) per UTC month, with 500 AI
messages in it — enough to evaluate it end to end. A **free key**, created with your email on the
ChannelGate platform, unlocks every conversation and keeps the 500-message monthly limit per
conversation; an Enterprise License removes the limit.

Open **Settings → License**, paste the key, **Save**, then **Verify now**. (Or set
`CHANNELGATE_LICENSE_KEY` in `.env` before the first boot.) The card shows the tier, when the key
was last verified, and this month's usage per conversation. Tiers, offline behaviour, and exactly
what the deployment sends are in [`docs/LICENSE-KEYS.md`](docs/LICENSE-KEYS.md); a key is never
required for the daemon to run, and an unlicensed or unreachable state never kills a run.

## 6. Set up access

In the admin UI:
- **Users** — approve the people who may use the bot (set their Composio token if they have one).
  Bot users only respond to *approved* users; unknown users are denied even in DMs.
- **Channels** — once the bot is invited to a channel and has seen a message there, it appears
  here. MakeItFuture members in a channel are auto-added to its allow-list on join. Set MCPs,
  skills, working folder, admin mode, or a channel-wide Composio token as needed.

## 7. Use it

- **DM** the bot — it replies (no mention needed).
- In a **channel**, `/invite` the bot, then **@mention** it.
- Attach a **voice clip** to that mention, react 🤖 to an existing voice message, or send one in a
  DM. Local Whisper is tried first when enabled. Otherwise the gateway reads Slack's completed
  transcript; click **Generate transcript** and trigger the bot again if Slack has not made one yet.
  Typed text is preserved as instructions and raw audio never reaches Claude or Codex.
- Browse the channel workspace with `/files`; from a thread, use the *Browse channel files* message
  shortcut or mention the bot with `/files`.
- Stop a run: `/stop`, or react 🛑 on a message, or type `stop`.
- Switch engine (Claude ↔ Codex) any time in **Settings**.

## Backup & restore config (encrypted)

Your config (`~/.channelgate/config` + each channel's `meta.json`) holds the Slack and
Composio tokens, user approvals, and channel settings. Back it up **encrypted, outside the
repo** — credential blobs never belong in git history, even encrypted:

```bash
npm run backup     # AES-256 encrypts config → ~/.channelgate/backups/config.tar.gz.enc
```

- The key is never stored with the blob:
  - default: a random key is generated once at `~/.channelgate/.backup-key` (keep it safe), **or**
  - set your own: `CG_BACKUP_PASSPHRASE='…' npm run backup` (nothing is written to disk).
- Re-run `npm run backup` anytime to snapshot the latest config, then copy the blob **and**
  the key somewhere safe off the machine (external drive, password manager, private storage).

**Restore on another machine:**
```bash
git clone https://github.com/makeitfutureDev/channelgate.git && cd channelgate
npm run setup
# copy your backup blob over — default location, or point CG_BACKUP_FILE at it:
#   mkdir -p ~/.channelgate/backups && cp /path/to/config.tar.gz.enc ~/.channelgate/backups/
# provide the SAME key you backed up with — either:
#   cp /path/to/.backup-key ~/.channelgate/.backup-key      (the generated key), or
#   export CG_BACKUP_PASSPHRASE='…'                            (your passphrase)
npm run restore    # decrypts into ~/.channelgate
launchctl kickstart -k gui/$(id -u)/com.makeitfuture.channelgate   # restart (or npm start)
```

> ⚠️ Without the key the backup cannot be decrypted. If you used the generated
> `~/.channelgate/.backup-key`, copy that file somewhere safe — it's the only way to restore.

## Where data lives

Channel **working folders** (the "discussions" — where the agent runs, reads/writes files,
uploads, `AGENTS.md`) live in a visible **`~/ChannelGate/<platform>/<channel>/`** (override the root
with `CG_WORKSPACE_DIR`), where `<platform>` is `slack`, `teams`, or `google-chat` — taken from the
channel's own record, so two surfaces never share a folder. A per-channel custom working folder is
used verbatim and is never namespaced. The hidden **`~/.channelgate/`** holds everything else
(below), with per-channel metadata under `channels/<platform>/<channel>/`.

### Upgrading from Claude Gateway for Slack

The first boot after the update runs `scripts/migrate-channelgate.mjs` automatically, before the
database opens and before Slack connects. It refuses while the old daemon (or a detached background
job, or a self-update transaction) is still running, then moves `~/.claude-gateway/` →
`~/.channelgate/` and each channel's `~/Slack Agent/<slug>/` → `~/ChannelGate/<platform>/<slug>/`,
rewrites stored absolute paths, regenerates every channel's sandbox, and leaves a `MOVED.md`
breadcrumb behind. Channels with a custom working folder are left exactly where they are. Nothing
is ever overwritten: an existing destination is skipped and reported.

Preview it first:

```bash
node scripts/migrate-channelgate.mjs --dry-run   # prints the plan, changes nothing
```

If the migration refuses or fails, the daemon keeps serving from the OLD paths (it pins
`CHANNELGATE_DIR` / `CG_WORKSPACE_DIR` back to them for that process) and logs what to clear.
`CLAUDE_GATEWAY_DIR` and `CLAUDE_GATEWAY_DB` are still honoured — with a one-time deprecation
warning — for one major; rename them to `CHANNELGATE_DIR` / `CHANNELGATE_DB`. Re-run
`npm run service:install` (macOS) or `sudo bash scripts/install-systemd.sh` (Linux) to move the
service to the new label/unit; each installer removes the pre-rename one first.

**Checkouts cloned from the previous repository.** The code moved to
`https://github.com/makeitfutureDev/channelgate` on 2026-09-03 with a fresh history (one initial
commit of the scrubbed tree); the old `claude-gateway-slack` repository is a read-only archive. Point
an existing checkout at the new repository and reset it onto the same tree — a plain `git pull`
cannot fast-forward across unrelated histories, and the updater refuses a diverged checkout by
design:

```bash
git remote set-url origin https://github.com/makeitfutureDev/channelgate.git
git fetch origin
git reset --hard origin/main      # identical files, new history
```

Then restart the service once: the updater compares the running revision with the checkout's
`HEAD` before it touches anything. To rename the checkout directory as well (the launch layout is
`~/Code/channelgate`), stop the daemon, move the directory, and repath every store that recorded the
old location — the channel records whose `workDir` is the checkout, Claude/Codex session state, the
sandboxes and the installed service definition:

```bash
node scripts/migrate-channelgate.mjs --repath --from "$OLD_CHECKOUT" --to "$NEW_CHECKOUT"
node scripts/migrate-channelgate.mjs --verify --from "$OLD_CHECKOUT" --to "$NEW_CHECKOUT"   # must print 0
```

The repath rewrites the service definition's `WorkingDirectory` and prints the reload command
(`systemctl --user daemon-reload`, or `bootout` + `bootstrap` on macOS) to run before starting the
service again. See `docs/OPERATIONS.md` → `--repath`.



Everything runtime is under `~/.channelgate/` (override with `CHANNELGATE_DIR`): config,
sessions, logs, and—only when installed—the local Whisper executable in
`tools/whisper/v1.9.1/` plus `models/whisper/ggml-large-v3-turbo.bin`. This directory is **not** in
the repo—back it up if you want to preserve config/sessions. Advanced deployments may override
`WHISPER_CLI_PATH`, `WHISPER_MODEL_PATH`, `WHISPER_FFMPEG_PATH`, or the five-minute
`WHISPER_TIMEOUT_MS`.

## Troubleshooting

- **"localhost refused to connect"** — the daemon isn't running. `launchctl list | grep
  channelgate`; restart with `launchctl kickstart -k gui/$(id -u)/com.makeitfuture.channelgate`,
  or `npm start`. Check `~/.channelgate/logs/launchd.err.log`.
- **Bot won't answer in a channel** — the author must be **approved** (Users tab) and the bot
  must be **@mentioned** (DMs need neither). New channels are fail-closed.
- **Images come back as "HTML"/can't read** — the Slack app needs the `files:read` scope; update
  the manifest and **reinstall** the app.
- **Voice transcript is unavailable** — if local Whisper is enabled, run `npm run whisper:install`
  and follow missing `ffmpeg`/`cmake` guidance. Otherwise click **Generate transcript** on the Slack
  voice note, then mention the bot again or react 🤖. Setup treats selected local provisioning
  failure as fatal; an update warns and keeps the gateway online.
- **Codex 401 / won't run** — `codex` isn't authenticated; run `codex login`.
