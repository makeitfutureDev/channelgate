---
title: Workspace and file controls
description: Reference for confined file listing, reading, search, Composio staging, and public links.
---

Paths are relative to the current conversation’s effective workspace. A signed run capability is checked on each call; effective Clean runs omit these tools. Workspace reads are also available to the permitted interactive SSH toolset. Files cannot escape the workspace through traversal or symlinks. See [files and editor](/docs/features/files-and-editor), [file sharing](/docs/features/file-sharing), and [public links](/docs/features/public-file-links).

## workspace_list

**Optional:** `path` (string; default workspace root, `""`), `recursive` (boolean; default false).

```json
{
  "path": "deliverables",
  "recursive": true
}
```

**Scope and result:** Read-only listing in the current workspace. Nonrecursive results identify `dir`, `file`, or `unavailable` plus relative path. Recursive results contain relative file paths, or an empty-folder notice.

**Limits:** Recursive traversal is bounded to 500 files and 500 visited real directories, with cycle detection. Inaccessible or escaping entries are not opened. This is a listing tool, not shell permission or a write operation.

## workspace_read

**Required:** `path` (string).

```json
{
  "path": "deliverables/plan.md"
}
```

**Scope and result:** Returns the UTF-8 contents of one confined regular text file. Available without granting a shell, including the read-only engine workspace path.

**Limits:** File size must be at most 65,536 bytes (64 KiB). Binary files containing NUL and invalid UTF-8 are refused. A size refusal is not a partial read; use an appropriate permitted tool for larger files.

## workspace_search

**Required:** `query` (nonempty string). **Optional:** `path` (string; default workspace root).

```json
{
  "query": "migration",
  "path": "docs"
}
```

**Scope and result:** Read-only literal, case-sensitive search of UTF-8 files under the supplied directory. Returns `relative/path:line:matching text`, or “No matches.” It does not interpret regular expressions.

**Limits:** At most 500 files, 2 MiB total scanned content, and 100 matching lines. Files above 64 KiB, invalid UTF-8, and binary files are skipped. Matching text is clipped to 500 characters per line. A bounded no-match result is not a proof that every workspace byte was scanned.

## stage_file_for_composio

**Required:** `path` (workspace-relative string), `tool` (target Composio tool slug), `identity` (`user` or `agent`, matching the identity that will execute that tool). **Optional:** `filename` (defaults to source name), `mimetype` (detected when absent).

```json
{
  "path": "deliverables/report.pdf",
  "tool": "GOOGLEDRIVE_UPLOAD_FILE",
  "identity": "user"
}
```

**Scope and result:** Stages actual file bytes into the selected Composio identity’s storage and returns the `{name, mimetype, s3key}` object inside its acknowledgement. Pass that object unchanged to the selected identity’s file-taking tool. Nothing becomes publicly downloadable.

**Limits:** The selected identity must have a usable token-mode key; Enterprise SDK sessions do not supply this staging key. The consumer/MCP-key limit is 25 MiB, project API-key limit 100 MiB. Staging on one identity does not allow the other identity to use its file. This does not itself authorize a subsequent upload or email send.

## create_public_file_link

**Required:** `path` (workspace-relative string), `purpose` (`upload` or `share`). **Optional:** `minutes` (positive integer); required for `share`, defaults to 5 for `upload`.

```json
{
  "path": "deliverables/report.pdf",
  "purpose": "share",
  "minutes": 120
}
```

**Scope and result:** Creates a temporary unauthenticated download URL for one confined file and returns the URL and expiry. An administrator must enable Public file links and configure Public URL. Human `share` requires an approval decision naming the file/duration; channel Auto does not supply that human decision.

**Limits:** `share` lasts at most 2,880 minutes (48 hours), with no configured fetch-count cap. `upload` lasts at most 15 minutes and permits 5 fetches; send it to the authorized ingest API, not the chat. The file is re-confined on each fetch. Turning the global switch off, revocation, or expiry stops future downloads. Public bytes already fetched cannot be recalled.

## list_public_file_links

**Arguments:** none.

```json
{}
```

**Scope and result:** Read-only listing of live public links belonging to the current conversation. Returns IDs, file paths, purpose, expiry, and fetch counts; empty state is explicit.

**Limits:** The actual token URLs are not recoverable from the listing. Other conversations’ links are not returned. Use the returned ID for revocation.

## revoke_public_file_link

**Required:** `id` (string, from the live-link listing).

```json
{
  "id": "example-link-id"
}
```

**Scope and result:** Revokes the named link in the current conversation and returns its file path and completed fetch count, or a no-such-link/already-expired notice.

**Limits:** An ID learned from another conversation cannot be revoked here. Revocation does not recall completed downloads.
