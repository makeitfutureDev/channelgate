# Chat platforms

ChannelGate speaks to three chat surfaces. Slack is GA; Google Chat and Microsoft Teams are in
**Beta** — their in-chat feature set is deliberately smaller (see *What works where* below).
Google Chat has been exercised against a live tenant; Teams still needs live tenant acceptance.

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

1. **Google Cloud project:** enable the *Google Chat API* and *Cloud Pub/Sub API* in the same
   project. Keep its project ID for the resource names below.
2. **Pub/Sub topic and subscription:** create a topic such as `chat-events`, then attach a
   **Pull** subscription such as `chat-events-sub`. The resource names have different forms:
   `projects/<project>/topics/<topic>` and `projects/<project>/subscriptions/<subscription>`.
3. **ChannelGate service account:** create a service account in the project and download its JSON
   key. On the **subscription's Permissions** panel, grant that account **Pub/Sub Subscriber**
   (`roles/pubsub.subscriber`). This is the identity ChannelGate uses to pull events and call the
   Chat API; keep its JSON key private.
4. **Chat app** (Google Chat API → Configuration): set its name, avatar, description, and
   **App status → Live - available to users**. Enable interactive features, including direct
   messages and, for spaces, *Join spaces and group conversations*. Set **Connection settings →
   Cloud Pub/Sub** to the full topic name `projects/<project>/topics/<topic>`. Set visibility so
   the intended testers can find the app, enable error logging, and **Save**.
5. **Google Chat publisher:** on the **topic's Permissions** panel, grant **Pub/Sub Publisher**
   (`roles/pubsub.publisher`) to the identity for the Chat app's configuration mode:
   - **Google Workspace add-on:** copy **Service account email** from the Chat API Configuration
     page's Cloud Pub/Sub connection settings (it may look like
     `service-<project-number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`). Grant that **exact**
     address the publisher role on the topic. This is separate from the JSON-key account in step 3.
     If the add-on checkbox is already selected and disabled, leave it selected; this mode works
     with ChannelGate.
   - **Standalone Chat app:** grant `chat-api-push@system.gserviceaccount.com` the publisher role
     on the topic. Google instructs you to clear *Build this Chat app as a Google Workspace
     add-on* when configuring a new standalone app. This publisher is **not** the one to use for
     an add-on.
6. **ChannelGate:** in Settings → Connection → *Google Chat*, paste the JSON key from step 3,
   enter `projects/<project>/subscriptions/<subscription>`, **Save**, then **Connect**. A
   *Connected — pulling …* status confirms the subscription can be polled; it does not establish
   that Google Chat can publish to the topic.
7. **Test:** add the Chat app to a space or open a direct message, then send a **new** message
   mentioning it in a space. Check for an actual ChannelGate reply. The sender must also be an
   approved user in ChannelGate's **Users** settings; otherwise the app responds that the user
   is not approved.

If the pull fails with `403`, recheck the step 3 **subscription** grant and reconnect. If it is
connected but receives no messages, recheck the step 5 **topic** grant for the app's actual mode,
then verify the Chat app is Live, interactive features are enabled, and its configured topic name
matches step 2. Google's [Workspace add-on Pub/Sub guide](https://developers.google.com/workspace/add-ons/chat/quickstart-pubsub),
[standalone Chat app Pub/Sub guide](https://developers.google.com/workspace/chat/quickstart/pub-sub),
and [Chat troubleshooting guide](https://developers.google.com/workspace/chat/troubleshoot-chat-apps)
cover these distinct configurations.

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

These additions are available on beta; live acceptance remains required before stable release.
Update the installed app's reviewed manifest so the bot entry has `supportsFiles: true` for native
personal-chat file consent, then upload/install that app revision with the Teams CLI as described
above. Adaptive Cards and their inline forms do not require additional Graph RSC permissions.
Task-module dialogs and broadcast mentions remain unavailable.

- `/help` provides a practical **How to use me** guide and the supported Teams command list
  in a native Adaptive Card, with separate headings, spaced paragraphs, individual emoji/command
  rows and monospace command text. Full spaced text is the fallback if card delivery fails.
  It explains personal/channel/group session continuity, mentions, voice, files, settings,
  connections, skills, memory, reminders, schedules and background work. In channels and group
  chats, mention the bot with the command; quote the original message or bot reply in a group
  chat to address that session. Help is returned by the gateway before invoking an engine.
  The reaction legend names Heart eyes robot (`:robot_face:`), Stop sign (`:octagonal_sign:`),
  and Tick button (`:white_check_mark:`). Robot activation accepts Teams' `hearteyesrobot` and
  `smilerobot` event IDs. Microsoft calls the green tick **Checkmark button**, ID
  `2705_whiteheavycheckmark`; Stop sign is `stopsign`. See the
  [Teams reactions reference](https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/teams-reactions-reference).
  Stop/Tick reactions have no gateway action in Teams; stop work with `/stop` or `/cancel`.
- `/settings` opens a six-page console in the original channel/thread or chat: General,
  Variables, MCPs, Skills, Automations and Resume. It retains the source conversation and session
  even when opened from a channel or group chat. `/secrets` opens its Variables page directly.
  No proactive personal chat is opened for settings. Buttons update that same card; other
  members open their own requester-bound `/settings` card.
  Initially only the section menu is shown; selecting a section reveals its controls below the
  menu. Switching sections replaces the controls while keeping the menu visible.
  General edits channel defaults and current-session engine/model/effort independently, with
  engine-labelled model choices, inherited labels and Follow channel default. One Apply to channel
  or Apply to thread button saves that scope's engine/model/effort together after compatibility
  checks. No intermediate runtime writes are needed; stale forms must be reopened. Other settings
  keep their explicit controls. Page navigation discards unsaved drafts. Authorized users can edit runtime,
  variables, connections, channel skills and automations, matching Slack Settings. Access controls
  require a current manager/admin, organization variable changes and Cloud MCP require admins.
  Native member selectors defer to the authenticated website when the complete roster exceeds
  25 members, exceeds the card budget; no hidden
  selection is silently removed. Former-member selections have an explicit replacement warning. VPN reports the existing service's actual availability;
  operator provisioning and unsupported Teams service identifiers are not changed by this UI.
  Variables and tokens are write-only: stored values never prefill a card, new entries use Teams'
  masked input style, and removal/reset actions require a one-use confirmation. Native entries
  follow the existing 8,000-character field and 16-KiB submission limits; larger values need the
  authenticated browser editor. Catalogs, templates and automations paginate. Resume resolves
  the current session at display time and provides its terminal command. Shared channel cards
  expose channel variable metadata only and never administrator session commands or ungranted
  private connection catalogs. Personal/organization variable controls remain in authenticated
  settings or an explicitly opened personal conversation.
  The sender name is the installed Teams app/bot identity. If another bot name appears, verify
  that the installed manifest bot ID, the configured Teams App ID and the Azure bot messaging
  endpoint all belong to the intended installation; changing card text cannot rename that app.
  Native approvals provide Approve/Deny/Request changes and supported scope choices. An optional
  changes comment refuses the current action, including when Approve was clicked. Card submissions
  take identity from the verified Microsoft envelope and repeat membership/role checks. Verified
  Execute errors use the Teams invoke response envelope; invalid request authentication remains
  an HTTP rejection. Legacy Submit replacements use only the card's server-stored message target.
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
