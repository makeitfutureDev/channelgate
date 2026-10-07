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

- **Small results or independent calls:** prefer `COMPOSIO_MULTI_EXECUTE_TOOL`. Its `tools` array
  contains `{tool_slug, arguments, account}` entries, with up to 50 logically independent calls.
  Include `session_id`, a concise `current_step` and `current_step_metric`, and the required
  `sync_response_to_workbench` boolean. Calls in one batch cannot consume each other's outputs;
  resolve dependencies in earlier calls. Process small structured results directly.
- **Large saved results:** set `sync_response_to_workbench: true` when executing if large output
  or later scripting is expected. Use the actual saved-file path returned by the executor.
  `COMPOSIO_REMOTE_WORKBENCH` runs Python in a persistent remote Jupyter sandbox; it is for remote
  files and bulk tool executions, not quick inline parsing, arithmetic or summaries.
- **Bulk app calls:** the workbench's preloaded
  `run_composio_tool(tool_slug, arguments, account=selected_account)` returns `(result, error)`.
  Use only already discovered app tools with known schemas, never `COMPOSIO_*` meta tools inside
  that helper. Inspect an ordinary request outside the workbench, an output schema, or the
  provided `invoke_llm` helper before assuming the response shape. Results have top-level `data`
  and can be nested; check `error` before using them.

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
