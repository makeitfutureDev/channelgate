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

### Notes and limits

- **No public URL ⇒ no inbound.** The bot will connect and can send, but Azure has nowhere to
  deliver to. ChannelGate says so at boot and on the health check rather than looking merely quiet.
- **Attachments in:** 1:1 uploads arrive with a pre-authenticated download URL and are fetched (only
  from Microsoft-owned hosts). Channel files live in SharePoint and need Graph application
  permissions with tenant admin consent — not requested, so those are reported as skipped.
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
| Live progress rendering | ✅ | placeholder → answer | placeholder → answer |
| Interactive approval buttons | ✅ | ❌ (actions named in text) | ❌ (actions named in text) |
| Approvals by signed link | ✅ (in addition to the buttons) | ✅ (the mechanism) | ✅ (the mechanism) |
| In-thread commands (`/model`, `/clear`, stop, steer) | ✅ | ❌ | ❌ |
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

This is what makes approvals *possible* on Teams and Google Chat rather than *already wired* there:
the link mechanism, its private delivery and its confirmation page are platform-neutral and honour
each adapter's declared `ephemeral` capability, but a turn on those surfaces still does not RAISE a
permission card (see the header of `src/platforms/ingest.js` — interactive approvals are a slice of
their own). When it does, the answer arrives by link with no further work.

---

## Operating both at once

Channel folders are namespaced by surface: `~/ChannelGate/slack/<slug>`,
`~/ChannelGate/google-chat/<slug>`, `~/ChannelGate/teams/<slug>`. A Slack `#ops` and a Teams "Ops"
are separate conversations with separate folders, sessions, memory, and settings — they never share
state, and neither can see the other's files.

Conversation ids are namespaced too (`gchat:spaces/AAA`, `teams:19:…`); Slack ids stay bare, so
every row written before multi-platform support keeps resolving with no migration.
