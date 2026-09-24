# Getting a file out of the working folder

You generated a PDF, a spreadsheet, an export. Something outside this conversation needs it —
Google Drive, an email attachment, a third-party API, a person. Files you write live in this
channel's container filesystem, which nothing outside the gateway can see, so "just give it the
path" never works.

Pick the route by **where the file is going**, in this order.

## 1. Into the conversation → just name the path

If the person only wants to see it here, write the folder-relative path in inline code
(`` `work/acme/PROPOSAL.pdf` ``) and the reply gets a `📄 PROPOSAL.pdf` button that opens it in the
file explorer. No tool call. See `references/writing-replies.md`.

## 2. Anywhere reachable through Composio → `stage_file_for_composio`

**This is the default for Drive, Gmail attachments, Slack uploads, HubSpot, e-signature tools —
anything with a Composio toolkit.** Nothing is published; the bytes go from the gateway straight
into Composio's storage over TLS.

Composio's file-taking tools do not accept a path or base64. They take
`{name, mimetype, s3key}`, where `s3key` names bytes already inside Composio's own storage. That
object is exactly what this tool returns.

```
stage_file_for_composio(
  path:     "work/acme/PROPOSAL.pdf",     # relative to this channel's working folder
  tool:     "GOOGLEDRIVE_UPLOAD_FILE",    # the Composio tool you are about to run
  identity: "agent"                       # "user" = composio-user, "agent" = composio-agent
)
→ { "name": "PROPOSAL.pdf", "mimetype": "application/pdf", "s3key": "…" }
```

Then run the Composio tool and pass that object through **unchanged** as its file argument.

Two things that will bite you if you skip them:

- **`identity` must match the identity you then execute with.** A file staged with
  `composio-user`'s key is invisible to `composio-agent`, and vice versa. Decide whose account is
  doing the upload first (the rules are in the skill's "Tool identities" section — an upload is a
  write, so the account must be settled, not guessed), then stage on that one.
- **`tool` is the real destination tool slug**, not a guess. Composio scopes the staged file to it.

If the reply says Composio already held those bytes, that is a deduplication hit, not a failure —
the `s3key` is good.

Two answers are final, and they mean different things:

- **`Staging refused:`** — the path is not a file of this conversation (outside the working folder,
  a symlink out of it, not a regular file). That path is not exported. Tell the user so. Do **not**
  copy the file into the working folder, or read it and re-create it, to get around the refusal.
- **`Staging failed:`** — Composio could not take the file (network, service, size). Report the
  failure in one line and stop. Do **not** push the file's contents through Composio's workbench,
  code execution or any other tool yourself: that routes the bytes through the conversation, which
  is exactly what staging exists to avoid.

Size: up to 25 MB on a Composio consumer key (the kind this gateway normally stores), 100 MB on a
project API key. Past that, say the file is too large to stage rather than splitting it.

## 3. A URL is the only way in → `create_public_file_link`

Some APIs ingest by URL rather than by body (`GOOGLEDRIVE_UPLOAD_FROM_URL` and friends), and
sometimes a person simply wants a link. This mints a **temporary public download URL**: anyone
holding it can fetch the file, with no login, until it expires.

Treat it as the fallback, not the habit. It requires an admin to have enabled public file links
and set the gateway's Public URL; when it is off, say so rather than working around it.

### `purpose: "upload"` — a machine is fetching it

```
create_public_file_link(path: "work/acme/PROPOSAL.pdf", purpose: "upload")
```

Lives **5 minutes** by default (15 maximum), allows 5 fetches, then dies. Hand it to the API that
needs it and **do not post it in the conversation** — it is plumbing, and posting it makes a
bearer URL part of the channel history.

### `purpose: "share"` — a person is fetching it

**Ask how long it should stay live before you call this.** `minutes` is required, there is no
default, and the ceiling is **48 hours** (2880 minutes). "For a day" → `minutes: 1440`; "just for
now" → ask whether they mean minutes or hours rather than picking for them.

```
create_public_file_link(path: "work/acme/PROPOSAL.pdf", purpose: "share", minutes: 1440)
```

A share link also needs a **human Approve click** — the card names the file and the duration.
That is deliberate: it publishes a file to anyone on the internet who has the URL, and a download
that already happened cannot be recalled.

When you hand over a share link, say plainly how long it lives and that anyone with the URL can
open it. Do not describe it as private or secure.

### Managing them

- `list_public_file_links` — this channel's live links, with file, purpose, expiry and fetch
  count. The URLs themselves are not recoverable, only revocable.
- `revoke_public_file_link(id)` — kills one immediately. Use it the moment a link has served its
  purpose, and offer it when someone says the file should not have gone out.

## What you cannot do

- **No link for a file outside this channel's working folder.** Every path is re-resolved inside
  the folder at mint time *and* again on every fetch. That holds even in a channel whose container
  mounts the operator home: a mounted host path is readable by your tools, it is not publishable.
- **No permanent link.** 48 hours is the hard ceiling, and there is no renewal that hides it —
  mint a new one, with the person asking again.
- **No link to a symlink.** A file reached through a symlink is readable in the folder but is not
  exportable; copy it to a real path first if it genuinely needs to go out.
