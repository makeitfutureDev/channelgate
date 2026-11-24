# Composio discovery, batches and Python scripts

Use the selected `composio-user` or `composio-agent` tools throughout one workflow. Read **Tool
identities** in `SKILL.md` first: unrestricted reads may use either identity, but a write requires
the intended identity and connected account. Account aliases route calls; they do not establish
the service owner's identity. Discover account metadata through that identity before claiming
ownership, using the returned account information or a discovered, read-only app profile tool.
Never read unrelated business records just to identify an account.

## Discover before executing

1. Read the currently exposed meta-tool descriptions; names and schemas can change. Call
   `COMPOSIO_SEARCH_TOOLS` with English `queries` (`use_case`, optional short `known_fields`) and
   `session: {generate_id: true}`. Reuse the returned `session_id` on subsequent meta-tool calls;
   a continuing search uses `session: {id: session_id}`. A different use case starts a new session.
   Review its plan, prerequisites, pitfalls and active connection/account metadata. Discovery is
   not authorization to connect an app or mutate data; follow the connection rules in `SKILL.md`.
2. Load each complete input schema before execution. For a returned `schemaRef`, call
   `COMPOSIO_GET_TOOL_SCHEMAS` with `tool_slugs` from the search and `session_id`. For Python,
   request `include: ["input_schema", "output_schema"]` to help establish the result shape.
   Never guess a slug, argument field, account ID or pagination parameter.
3. Resolve required IDs and the account before dependent calls. With multiple connected accounts,
   set each executor entry's `account` to the selected alias or account ID. Keep identity selection
   separate from account selection. If a write's intended account remains unresolved, ask which
   account; continue independent authorized reads. Do not substitute identities after an error.

## Choose the executor

Composio Remote Workbench and Remote Bash are admitted by the gateway for remote data processing and bulk app
calls. Their Python/shell code is not inspected by the structured membership-approval check. Any Slack
join/invite/channel-creation action still needs human approval: issue it as a structured action
and wait for its card, following `references/messages.md`.

- **Small results or independent calls:** prefer `COMPOSIO_MULTI_EXECUTE_TOOL`. Its `tools` array
  contains `{tool_slug, arguments, account}` entries, with up to 50 logically independent calls.
  Include `session_id`, a concise `current_step` and `current_step_metric`, and the required
  `sync_response_to_workbench` boolean. Calls in one batch cannot consume each other's outputs;
  resolve dependencies in earlier calls. Process small structured results directly.
- **Large saved results:** set `sync_response_to_workbench: true` when executing if large output
  or later scripting is expected. Use the actual saved-file path returned by the executor.
  `COMPOSIO_REMOTE_WORKBENCH` runs Python in a persistent remote Jupyter sandbox; it is for remote
  files and bulk tool executions, not quick inline parsing, arithmetic or summaries.
- **Local processing:** when records are returned inline, save them in the channel workspace and
  run Python in the channel container when its mode permits shell/file work. A Composio
  `/mnt/files/` path belongs to the remote sandbox and cannot be opened locally. A Workbench
  failure alone does not mean local analysis or further structured reads are unavailable.
- **Bulk app calls:** the workbench's preloaded
  `run_composio_tool(tool_slug, arguments, account=selected_account)` returns `(result, error)`.
  Use only already discovered app tools with known schemas, never `COMPOSIO_*` meta tools inside
  that helper. Inspect an ordinary request outside the workbench, an output schema, or the
  provided `invoke_llm` helper before assuming the response shape. Results have top-level `data`
  and can be nested; check `error` before using them.

## Code with connections: Workbench or this container

There are two places to run code that calls connected apps. Choose by what credential exists, not
by habit. Which Composio mode this gateway runs decides what each identity IS, and so what a local
script needs; this run's Composio identity line repeats the mode.

<!--if:composio-sdk-->
**This gateway runs Composio in SDK mode.** One organization SDK key, held by the daemon and never
present in a container, backs every identity. Each identity is a stable **user id in the
organization's Composio project**: the requester's for `composio-user`
(`slack:<team>:user:<user id>`, or the Teams/Google Chat equivalent) and this conversation's for
`composio-agent` (`slack:<team>:channel:<channel id>`). This run's identity line gives the exact
ids. Connections people make — in Settings → Connections, the Activity page, or a connection you
initiate on request with `COMPOSIO_MANAGE_CONNECTIONS` (never for inventory) — are stored under those ids, so every path below reaches the SAME
connected accounts. The MCP tools run in a tool-router session scoped to this thread.

- **Meta tools and Workbench (always available):** `COMPOSIO_MULTI_EXECUTE_TOOL`,
  `COMPOSIO_REMOTE_WORKBENCH` and `COMPOSIO_REMOTE_BASH_TOOL` act as the session's user id. In the
  Workbench, `run_composio_tool(tool_slug, arguments, account=…)` calls the same connections.
  Nothing to install and no key in this container. The organization's allowed-apps and
  multi-account policy applies to the session.
- **Local SDK script in this container:** needs an API key **for the same Composio project** as
  the gateway's SDK key in this run's credential inventory (for example a hidden
  `COMPOSIO_API_KEY_SDK` approved for `backend.composio.dev`). Before relying on it, prove it is
  the same project: list the connected accounts of the identity's user id and check they match what
  `COMPOSIO_SEARCH_TOOLS` reported. An empty list for an identity that has connections means a
  different project; stop and say so. Then execute with that user id and the selected account:

  ```js
  // npm install @composio/core   (in the work folder; not shipped in the image)
  import { Composio } from "@composio/core";
  const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY_SDK });
  const userId = "slack:T…:user:U…"; // exact id from this run's identity line, for the selected identity
  const { items } = await composio.connectedAccounts.list({ userIds: [userId], toolkitSlugs: ["gmail"] });
  const result = await composio.tools.execute("GMAIL_FETCH_EMAILS", {
    userId, connectedAccountId: items[0].id, arguments: { max_results: 10 },
    version: "<toolkit version>", // or dangerouslySkipVersionCheck: true for a one-off
  });
  ```

  The Python SDK (`pip install composio`) has the same calls (`connected_accounts.list`,
  `tools.execute`). Without such a key this path does not exist; the organization SDK key is
  deliberately daemon-side, never ask for it.
<!--endif-->
<!--if:composio-personal-->
**This gateway runs Composio in Personal mode.** Each identity is its owner's **own Composio
account**, reached through a Composio consumer key the gateway stores and relays:
`composio-user` is the requester's key (set in Settings → You, or the App Home), `composio-agent`
is this conversation's own key. A consumer key is not an SDK project API key, it never enters this
container, and there is no organization project behind it: each identity's connections live in a
different Composio account.

- **Meta tools and Workbench (always available):** `COMPOSIO_MULTI_EXECUTE_TOOL`,
  `COMPOSIO_REMOTE_WORKBENCH` and `COMPOSIO_REMOTE_BASH_TOOL` run against that identity's account.
  In the Workbench, `run_composio_tool(tool_slug, arguments, account=…)` calls its connections.
  This is the normal way to write code against a Personal-mode identity.
- **Local SDK script in this container:** only when the owner of that same Composio account added
  a **project API key from that account** to this run's credential inventory (a conversation
  variable for `composio-agent`'s account, or the requester's personal variable for their own).
  The account's user id is not known in advance: list the key's connected accounts and match them
  to the aliases `COMPOSIO_SEARCH_TOOLS` reported for the selected identity before executing; if
  none match, the key belongs to another account — stop and say so. Then call
  `composio.tools.execute(slug, { userId, connectedAccountId, arguments, version })` with
  `@composio/core` (Node) or the Python SDK (`pip install composio`), installed in the work folder. Without
  such a key the Workbench is the only code path.
<!--endif-->

Either way, the Workbench keeps code, intermediate data and saved files in Composio's remote
sandbox and is best for one-off exploration and bulk calls; a local script keeps them in the work
folder, can be saved and re-run without spending model tokens, and can use local libraries,
files and background jobs — best for repeatable automation. Never try to extract, copy or
reconstruct the `composio-user`/`composio-agent` credentials or session URLs: they are
deliberately gateway-side.

Both paths still execute every app call on Composio's servers, so Composio sees each request and
response either way; the container only keeps code, intermediate data and stored results out of
the remote sandbox. Composio bills app calls either way. Neither path has a measured cost advantage
unless you actually measured it — say so instead of claiming one.

A project API key is **not** a personal credential: it can act as ANY user id in that Composio
project, read their connected accounts and create or delete connections. Use only the `userId`
and connected account matching the identity the request selected (the requester for "my", the
channel's shared identity for "your/the agent's"), never another person's. Do not recommend
sharing a project key with other channels or with organization scope; anyone who can talk in a
channel holding it can act as every user in the project.

## Workbench limits and batch pattern

Each workbench cell has a hard **180-second limit**. Pass `code_to_execute`, `session_id`, and
concise step/metric fields. Imports, variables and functions persist between cells; do not import
or redefine its preloaded helpers. Use bounded `ThreadPoolExecutor` concurrency for independent
calls and split work into resumable batches. Never blindly replay mutations after a timeout:
reconcile the destination and checkpoint first. Follow every pagination cursor to exhaustion
when completeness is required; only parallelize pages if the API supports independent page IDs.

This read-only batch pattern assumes `jobs_path` is the actual remote JSON file already prepared
from discovered, schema-validated calls, and each job contains its selected `account`. Do not
execute unresolved placeholders. Choose `output_path` under `/mnt/files/` for a resumable batch.

```python
import json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

jobs = json.loads(Path(jobs_path).read_text())
def fetch(job):
    result, error = run_composio_tool(
        job["tool_slug"], job["arguments"], account=job["account"])
    return {"ok": not bool(error), "result": result if not error else None}

with ThreadPoolExecutor(max_workers=4) as pool:
    rows = list(pool.map(fetch, jobs))
Path(output_path).write_text(json.dumps(rows))
print({"total": len(rows), "succeeded": sum(row["ok"] for row in rows)})
```

Record failed item indexes and safe error classes separately for reconciliation; do not print
raw payloads or credentials. Top-level cells cannot use `return`; finish with `output` or
`print(output)`. Use `invoke_llm` for semantic extraction or summaries, with an explicit output
schema and small batches. `COMPOSIO_REMOTE_BASH_TOOL` can inspect remote saved files with its
`command` and `session_id`; it has the same 180-second limit. Prefer a discovered app tool over
custom API calls. The workbench's `proxy_execute` is for APIs without a Composio tool, limited to
one toolkit per workbench call; check its `(result, error)` too. A restriction is a stop condition,
not permission to route around the connector or gateway policy.

## Remote files and credentials

The sandbox is **remote**, with home `/home/user`; its paths are not files in this channel's
container. Long outputs become artifacts under `/mnt/files/.composio/output`, cloud-backed and
persistent across sandbox restarts. Save checkpoints under `/mnt/files/`; do not assume that a
remote path can be opened locally. For a user-downloadable remote artifact, call the preloaded
`upload_local_file` on its actual remote path, check `(result, error)`, and share the returned
download URL when authorized. Do not present a raw sandbox path as a user download link.

For a file **in this channel's working folder**, retain `references/sharing-files.md`: call
`gateway` → `stage_file_for_composio` with the executing identity (`user` or `agent`) and destination
tool, then pass its `{name, mimetype, s3key}` result unchanged to that identity's file-taking tool.
A URL-only ingestion tool uses `create_public_file_link` with purpose `upload`. Never transfer
file bytes as base64 or chunks through Python, bash or app tools to bypass staging, including when
staging fails or the file is too large. To share a local file in this thread, use the gateway's
native file-sharing tool instead.

Channel credentials stay subject to `references/administration.md` and the current run inventory.
Do not copy local environment secrets, protected placeholders or engine credentials into the
remote sandbox or custom request bodies. Hidden placeholders only resolve through the gateway's
approved egress route; they are not portable credentials. Use the selected connector's existing
authentication, and never print credentials or ask for raw secrets to work around a refusal.
