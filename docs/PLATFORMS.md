# Chat platforms

ChannelGate speaks to three chat surfaces. Slack is GA; Google Chat and Microsoft Teams are in
**Beta** — their transports are implemented and tested, but have not yet run against a live
tenant, and their in-chat feature set is deliberately smaller (see *What works where* below).

Every surface goes through the same seam: a capability descriptor in `src/platforms/<id>.js`, a
`ChatConnector` that owns the wire format, and one platform-neutral ingest path
(`src/platforms/ingest.js`) that gates, authorizes, runs the turn and posts the answer. The channel
confinement, authorization model, and MCP allowlist are identical on all three — none of that is
per-platform, and none of it is relaxed to make a surface work.

---

## Google Chat (Beta)

**Transport: Pub/Sub pull.** Google publishes your Chat app's events to a topic you own, and the
daemon pulls them over an outbound HTTPS connection. No inbound endpoint, no tunnel, no firewall
rule — the same posture as Slack's Socket Mode.

### Setup

1. **Google Cloud project** — enable the *Google Chat API* and the *Cloud Pub/Sub API*.
2. **Topic + subscription** — create a topic (e.g. `chat-events`) and a **pull** subscription on it
   (e.g. `chat-events-sub`).
3. **Service account** — create one, download a JSON key, then:
   - grant it `roles/pubsub.subscriber` **on the subscription**;
   - grant Chat's publisher service account `chat-api-push@system.gserviceaccount.com` the role
     `roles/pubsub.publisher` **on the topic** (this is what lets Google publish to it).
4. **Chat app configuration** (Google Chat API → Configuration):
   - app name, avatar, description;
   - enable *Receive 1:1 messages* and *Join spaces and group conversations*;
   - **Connection settings → Cloud Pub/Sub**, with the topic from step 2;
   - subscribe to the message and membership events.
5. **ChannelGate** — Settings → Connection → *Google Chat*: paste the service-account JSON, enter the
   subscription as `projects/<project>/subscriptions/<name>`, Save, then **Connect**.

The app's own `users/…` id is learned automatically the first time it is added to a space; the
optional field exists only to short-circuit that.

### Notes and limits

- **Attachments in:** files uploaded directly in Chat are downloaded through `media.download`. A file
  shared from the Drive picker needs a user-OAuth Drive scope ChannelGate deliberately does not
  request — those are reported as skipped rather than silently dropped.
- **Attachments out:** `media.upload` requires user OAuth, so the bot cannot upload files. Answers
  are text.
- **Threads:** in a space, threads are honoured. In a DM, Google mints a *new* thread for every
  top-level message, so a thread seen for the first time is treated as the main flow (one continuous
  DM session) and a thread you explicitly reply into becomes a real side thread.
- **Editing:** 1 write/sec per space, shared with every other app in it. Deleting leaves a tombstone,
  so ChannelGate edits rather than deletes.
- **No ephemeral messages:** a notice meant for one person is sent as a DM to that person instead.

---

## Microsoft Teams (Beta)

**Transport: Bot Framework (public HTTPS endpoint).** Every supported Teams bot path delivers
messages as inbound POSTs from Azure Bot Service — there is no outbound-only receive path. The
daemon already terminates public HTTPS for the admin UI and the run API, so the endpoint rides that
server. Requests are authenticated against the Bot Framework JWKS (`src/platforms/msteams/verify.js`)
before anything else happens; that check is the entire authentication boundary for this surface.

> An **Azure Relay Hybrid Connection** would remove the public-URL requirement (the daemon holds an
> outbound websocket and the Relay tunnels POSTs down it). It is a transport swap in FRONT of the
> same handler — everything behind it is unchanged — and stays on the roadmap.

### Setup

Use Microsoft's [Teams Developer CLI](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/get-started/quickstart-register)
to create the bot registration and Teams app together. These commands were checked against CLI
3.0.3; install the stable package below. The normal Teams-managed bot path does not need an Azure
subscription or a hand-built manifest.

Before starting, identify the target ChannelGate installation and its public HTTPS origin. If
multiple gateways exist, do not use the current checkout's URL or settings for another bot.
You need a Microsoft 365 account permitted to register the app and install custom Teams apps.

1. **Install and sign in to the Teams CLI:**

   ```sh
   npm install -g @microsoft/teams.cli
   teams --version
   teams login --device-code
   teams status
   ```

   Open the URL printed by the CLI, enter its short-lived code, and sign in to the intended
   organization. Keep the login process alive until it confirms success, then check the account,
   tenant and custom-app upload status with `teams status`. A browser saying "done" alone is not
   proof the CLI authenticated. On a desktop, `teams login` also supports browser sign-in.
   If `teams` is not found after installation, add the npm global prefix's `bin` directory to
   your shell's PATH (`npm prefix -g` prints the prefix).

   When an assistant runs this flow, it must keep the same interactive process alive, provide
   the code in a progress message, and poll until success or expiry before ending the turn.
   An expired code needs a fresh login. Do not request passwords or authentication tokens in chat.

2. **Create the public event URL.** Teams cannot deliver events to `localhost`. For production,
   set Settings → Connection → *Public URL* to the daemon's public HTTPS origin. For local use,
   expose the daemon with a persistent HTTPS tunnel and use that origin. The Admin UI shows the
   resulting endpoint: `<public-url>/api/teams/messages`.
3. **Generate the bot and Teams app with that endpoint.** Run this in a private operator terminal;
   creation can print the client secret. Change the display name to your bot's name. To capture
   credentials, add `--env /absolute/private/path/teams.env` with a protected destination outside
   the repository and channel work folders; use `umask 077` before creation. Do not stream the
   creation output into chat or commit the credentials.

   ```sh
   umask 077
   ```

   Then create the app:

   ```sh
   teams app create \
     --name "ChannelGate" \
     --endpoint "https://<public-url>/api/teams/messages"
   ```

   Save the emitted `CLIENT_ID`, `CLIENT_SECRET`, and `TENANT_ID`; the secret is shown only once.
   Also retain the emitted Teams app ID for installation; it is distinct from the Application
   (client) ID. Keep personal, team and groupChat scopes for the conversations you intend to use.
   For an existing registration, use `teams app list` and `teams app get <teamsAppId>` to inspect
   it before creating a duplicate.
4. **Configure ChannelGate** — Settings → Connection → *Microsoft Teams*: paste `CLIENT_ID` as the
   Application ID, `CLIENT_SECRET` as the client secret, and `TENANT_ID` as the tenant, Save, then
   **Connect**.
5. **Install the generated app in Teams:**

   ```sh
   teams app get <teamsAppId> --install-link
   ```

   Open the printed link in a browser or Teams client and install the app. If the public URL later
   changes, update the registered event endpoint with
   `teams app update <teamsAppId> --endpoint "https://<new-public-url>/api/teams/messages"`.

6. **Verify the connection with a real conversation.** Approve the test user's Teams identity in
   the target ChannelGate installation; a Slack approval does not grant a separate Teams identity.
   Send `Reply with TEAMS_OK` in a personal chat, then `@<bot-name> Reply with TEAMS_OK` in a test
   team/channel. Confirm a real answer in the personal chat and a threaded channel reply. A
   "Connected" badge alone does not prove inbound delivery. See the live acceptance case in
   `TEST-PLAN.md`; Teams remains beta until tenant verification is completed.

### Optional all-message edit and reaction events (experimental)

The `teams-ms` branch adds an opt-in **Observe edits and robot reactions on all messages**
setting under Settings → Connection → Microsoft Teams (`teamsAllMessageEvents`, default `false`).
It requests Graph subscriptions for known installed conversations, not a tenant-wide message feed.
Normal group/channel messages still need a real bot mention. A robot reaction is an explicit
activation by the reacting user and is checked against that user's current ChannelGate access.

For a test installation, extend the CLI setup above:

1. Download the app's current manifest using `teams app manifest download --help` for the installed
   CLI's output options. Preserve its IDs, icons, scopes and existing permissions. Merge these
   entries into `authorization.permissions.resourceSpecific` (do not replace other grants):

   ```json
   [
     { "name": "ChatMessage.Read.Chat", "type": "Application" },
     { "name": "ChannelMessage.Read.Group", "type": "Application" }
   ]
   ```

   Ensure `webApplicationInfo.id` identifies this bot's Entra application and retain the valid
   `webApplicationInfo.resource` field. These are resource-specific **application** grants,
   consented for the chat/team where the app is installed. See Microsoft's
   [RSC manifest and consent instructions](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/grant-resource-specific-consent).
2. Upload the reviewed manifest, using the separate Teams app ID:

   ```sh
   teams app manifest upload ./manifest.json <teamsAppId>
   teams app get <teamsAppId> --install-link
   ```

   Current CLI syntax puts the file before the app ID; verify with `teams app manifest upload --help`
   when using an older CLI. The [upload command](https://microsoft.github.io/teams-sdk/cli/commands/app/manifest-upload/)
   preserves icons and can bump the package version. Alternatively,
   [`teams app manifest update`](https://microsoft.github.io/teams-sdk/cli/commands/app/manifest-update/)
   supports `--set-json` and `--dry-run`; preview the complete merged permission array before upload.
3. Update or reinstall the app in each intended test chat/team and accept the new permissions under
   that tenant's policies. Updating the developer registration alone does not prove resource consent.
4. Set the public HTTPS URL, enable the checkbox, save, then disconnect/reconnect Teams. Allow both
   `/api/teams/messages` (Bot Framework) and `/api/teams/notifications` (Graph notification validation
   and delivery) through the existing public reverse proxy. The Graph notification URL is separate
   from the bot messaging endpoint; do not replace the bot endpoint with it.
5. Send a bot mention in each installed test conversation. An authenticated activity establishes the
   known conversation before automatic subscription creation. Existing messages from unknown chats
   are not swept or retroactively subscribed across the tenant. Subscriptions renew while enabled;
   inspect event logs for consent, renewal or delivery failures. A Connected banner verifies neither
   Graph consent nor subscription coverage.
6. Perform the event tests in `TEST-PLAN.md`: add a real mention by editing an existing user message,
   react with 🤖 to a user message, and react to a bot reply to continue its session. Confirm actor,
   target and session attribution with both Claude and Codex. Include an external-member group and
   desktop/mobile clients. Do not declare all-message coverage from bot-reply reaction tests alone.

The chat Graph route uses **Microsoft Graph beta**, so this feature remains experimental. A granted
read permission does not guarantee every client emits the same reaction shape or that every
federated conversation supports the subscription. The switch does not grant file/SharePoint access,
allow unapproved users, or enable agent responses to every observed ordinary message. Bot Framework
edit/reaction handling and optional Graph observation have distinct delivery coverage. Real tenant
acceptance has not been performed as part of this branch's local implementation.

See [the full Slack-to-Teams parity audit](TEAMS-PARITY.md) for remaining UI and integration gaps.

### Native cards, workspace files and voice (teams-ms branch)

These additions are branch-only; they do not imply a deployment or completed live acceptance.
Update the installed app's reviewed manifest so the bot entry has `supportsFiles: true` for native
personal-chat file consent, then upload/install that app revision with the Teams CLI as described
above. Adaptive Cards and their inline forms do not require additional Graph RSC permissions.
Task-module dialogs and broadcast mentions remain unavailable.

- `/settings` opens a private session engine/model/effort form. `/secrets` opens the same card with
  a link to the existing authenticated admin website. Enter secrets there, never in Teams cards.
  Native approvals provide Approve/Deny/Request changes and supported scope choices. An optional
  changes comment refuses the current action, including when Approve was clicked. Card submissions
  take identity from the verified Microsoft envelope.
- `/files [folder]` privately browses the current conversation workspace. Open a file to download
  it or edit eligible text; users with file-write access can open the uploader. Browser links are
  short-lived grants and recheck current Teams membership and gateway policy. A group request
  keeps the original group workspace even though its controls arrive in a personal chat.
- `/sendfile <workspace-relative-path>` sends a personal-chat file-consent card. Accept uploads
  the prepared snapshot; Decline does not upload. The native limit is a nonempty file of at most
  10 MB, consent expires after ten minutes, and uncertain upload outcomes are not replayed.
  Larger files use the private browser download path. Install/open a personal chat first if
  Microsoft cannot deliver private controls or file-consent cards.
- Downloadable audio uses local Whisper only, controlled by the existing Whisper setting. No
  Slack-generated transcript is requested. A failed audio-only request explains the missing
  transcript without invoking an engine; accompanying typed text can continue. Stop cancels
  local transcription as well as engine work. Separate intake directories keep simultaneous
  uploads and edits from overwriting another request's audio or files.

For optional **group/channel file reading**, enable **Read group and channel files from allowed
drives** under Microsoft Teams settings and enter up to 32 exact Microsoft drive IDs, one per
line (`teamsFilesEnabled`, `teamsFileDriveIds`). Configure application read access to those sites
externally using [Microsoft's selected permissions](https://learn.microsoft.com/en-us/graph/permissions-selected-overview),
then save and reconnect Teams. The deployment's configured Graph identity must have access to
those drives; neither the checkbox nor the allowlist grants Microsoft permissions. This is a
gateway-wide allowlist for authorized conversations, not a per-user Microsoft file entitlement.

Use canonical SharePoint file URLs whose paths lie inside an allowed drive root. The resolver
reads only configured drive roots, addresses the matching item within that drive, verifies its
returned identity, and downloads with no Graph bearer on the file-host request. Redirects and
oversized responses are refused. Sharing shortlinks are unsupported: use a canonical file link
or upload directly in a personal chat. The implementation deliberately does not use Graph's
[sharing-link endpoint](https://learn.microsoft.com/en-us/graph/api/shares-get?view=graph-rest-1.0),
whose documented application permissions include broad write access. Selected-site consent and
real SharePoint download compatibility remain live acceptance gates.

See `TEST-PLAN.md` for exact native-card, file, voice and both-engine fixtures. Native file flow
reference: [Microsoft bot file consent](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4).

### Notes and limits

- **No public URL ⇒ no inbound.** The bot will connect and can send, but Azure has nowhere to
  deliver to. ChannelGate says so at boot and on the health check rather than looking merely quiet.
- **Attachments in:** 1:1 uploads arrive with a pre-authenticated download URL and are fetched (only
  from Microsoft-owned hosts). Group/channel references require the optional scoped drive
  configuration above; unsupported or unconsented files are explicitly reported as skipped.
- **Threads and sessions:** channel replies thread under the user's message. Personal chats keep
  one continuous session. Group chats remain visually flat, but every new message to the bot starts
  a separate session. Quote an earlier user message or bot reply to continue that session; quote
  mappings survive daemon restarts. Include an @mention in group-chat quoted replies too, because
  Teams does not deliver them to the bot by default without one. Current quotedReply entities and
  legacy Reply blockquotes identify the quoted message; ordinary blockquotes do not.
  See Microsoft's [quoted reply format](https://microsoft.github.io/teams-sdk/blog/quoted-and-threaded-replies/).
- **Formatting:** no tables, no headings, no inline images, and lists render on desktop only — all
  four are degraded on the way out by `src/platforms/format/degrade.js`.
- **Mentions** are structural: the text carries `<at>Name</at>` and the activity must carry a
  matching entity. The formatter emits both together.
- **No ephemeral messages:** as on Google Chat, a per-person notice becomes a 1:1 chat message —
  which is how approval links reach the person who raised the request.

---

## What works where

| | Slack | Google Chat | Teams |
| --- | --- | --- | --- |
| Turns in channels and DMs | ✅ | ✅ | ✅ |
| Channel folder confinement, authorization, MCP allowlist | ✅ | ✅ | ✅ |
| Attachments in | ✅ | partial | partial |
| Threads | ✅ | spaces only | channels only |
| Live progress rendering | ✅ | bounded progress → answer | bounded progress → answer (branch) |
| Interactive approval buttons | ✅ | ❌ (actions named in text) | native cards (branch) |
| Approvals by signed link | ✅ (in addition to the buttons) | ✅ (the mechanism) | ✅ (the mechanism) |
| Session commands | full Slack controls | portable text subset (branch) | text subset + native settings/files (branch) |
| Native tables / charts / Lists / canvases | ✅ | ❌ | ❌ |
| Escalation to full-access in an admin-mode channel | ✅ | ❌ | ❌ |

The last row is not an oversight. Escalation requires an interactive permission prompt the author
can answer; until a surface has one, a run there uses the channel folder's permission allowlist like
every other run — which fails closed.

**Approvals reach every surface as links.** Slack's Block Kit buttons are the primary control and
are unchanged. Alongside them, each approval card and each busy-thread card is also minted as
short-lived, single-use, HMAC-signed URLs — one per action the recipient may take — delivered
**privately to the person who raised the request**: an ephemeral where the platform has one
(Slack), a 1:1 message where it does not (Teams, Google Chat). Opening a link shows a confirmation
page and decides nothing; the page's Confirm button performs the decision through exactly the code
a button click runs. The gateway needs a **Public URL** for a link to be reachable from outside the
host, and the behaviour is Settings → Connection → **Approval links** (`auto` / `always` / `off`).
See `FEATURES.md` → Modes & approvals for the security properties.

On `teams-ms`, native Teams approval cards call the shared actor-checked decision path. Inline
cards do not automatically widen the engine permission policy: escalation remains separately
gated, and its live acceptance must pass before release. Google Chat retains its existing
surface limitations. Task-module dialogs and Slack's full busy-thread interaction flow are not
supplied by the Teams card implementation.

---

## Operating both at once

Channel folders are namespaced by surface: `~/ChannelGate/slack/<slug>`,
`~/ChannelGate/google-chat/<slug>`, `~/ChannelGate/teams/<slug>`. A Slack `#ops` and a Teams "Ops"
are separate conversations with separate folders, sessions, memory, and settings — they never share
state, and neither can see the other's files.

Conversation ids are namespaced too (`gchat:spaces/AAA`, `teams:19:…`); Slack ids stay bare, so
every row written before multi-platform support keeps resolving with no migration.

Graph event processing intentionally accepts only edits/reaction additions from the preceding
24 hours (and after subscription activation). This is shorter than the seven-day deduplication
retention, so later updates cannot replay old message history. Personal Bot Framework conversations
use different IDs from Graph chats: personal edits and reactions to bot answers stay on the native
bot event path. Graph subscriptions here cover group chats and channels. Removing Xavier retires
the corresponding subscription and invalidates its queued event work. Graph file descriptors are
reported when unavailable; this option does not grant SharePoint file-download permissions.
