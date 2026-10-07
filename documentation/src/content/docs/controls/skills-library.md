---
title: External skills library controls
description: Ten scoped tools exposed by the separate Streamable HTTP catalog endpoint.
---

Endpoint: `POST /mcp/skills` with `Authorization: Bearer <skills-access-token>`. Administrators mint named, scoped, revocable tokens under **Skills → MCP → MCP access**. Scopes are independent: read, propose, manage, sync. Invalid/revoked tokens get HTTP 401; a valid token lacking a tool’s scope receives a refusal. The JSON request limit is 20 MB and text responses are bounded to 60,000 characters. This endpoint cannot reach the gateway administration API.

## library_search_skills

Search discoverable shared catalog packages with pagination.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `query` | No | Text search; default empty. |
| `category` | No | Category filter; default empty. |
| `source` | No | Source ID or case-insensitive label; default empty. |
| `limit` | No | Integer 1–200; default 50. |
| `offset` | No | Nonnegative integer; default 0. |

**Authority and scope:** A valid skills bearer access token with `read` scope; no admin browser session is used.

**Result:** JSON total/count/offset, has_more, next_offset, items and category/source facets.

**Restrictions:** Personal packages are not the shared library. Unknown source returns an empty result with facets rather than importing anything.

## library_get_skill_info

Read one shared package’s metadata.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `name` | Yes | Catalog slug/name. |

**Authority and scope:** A valid skills bearer access token with `read` scope; no admin browser session is used.

**Result:** JSON summary, effective revision number and file paths.

**Restrictions:** Rejects deleted, personal, or undiscoverable packages. No body is returned.

## library_get_skill_file

Read an effective-revision package file.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `name` | Yes | Catalog slug/name. |
| `file` | No | Package-relative path; default SKILL.md. |

**Authority and scope:** A valid skills bearer access token with `read` scope; no admin browser session is used.

**Result:** Text or JSON `{path,content_type,encoding:"base64",content}` for binary files.

**Restrictions:** Rejects personal/undiscoverable/deleted packages and unavailable revisions/files. Text responses are clipped to 60,000 characters.

## library_list_templates

List resolved skill templates.

**Arguments:** none.

**Authority and scope:** A valid skills bearer access token with `read` scope; no admin browser session is used.

**Result:** JSON items with names, slugs, descriptions, resolved skills and categories.

**Restrictions:** Listing does not assign a template or grant skills to a conversation.

## library_whoami

Inspect this library token’s identity and scopes.

**Arguments:** none.

**Authority and scope:** Any valid skills access token; no additional scope is required.

**Result:** JSON authenticated state and token ID, name, scopes, created_at.

**Restrictions:** Never returns the token value; token identity is not a chat user identity.

## library_suggest_skill_change

Submit changed files or feedback for administrator review.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `name` | Yes | Target catalog slug/name. |
| `note` | Yes | Explanation. |
| `files` | No | File array; default empty. Each file is `{path, content, encoding?}`: path and content required; encoding is `utf8` or `base64` (omitted means text). Paths are inside the package. |

**Authority and scope:** Skills token with `propose` scope.

**Result:** JSON ok, proposal_id and status; or diagnostic.

**Restrictions:** Files produce a change proposal; no files produces feedback. Attribution uses token:<id>. Does not directly activate a revision.

## library_create_skill

Create a local shared package from files.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `slug` | No | Folder name; default derived from frontmatter. |
| `files` | Yes | Nonempty file array. Each file is `{path, content, encoding?}`: path and content required; encoding is `utf8` or `base64` (omitted means text). Paths are inside the package. |
| `note` | No | Revision note; default empty. |

**Authority and scope:** Skills token with `manage` scope.

**Result:** JSON ok, name, revision and published boolean.

**Restrictions:** SKILL.md required. No personal/chat scope argument is provided. The token is powerful enough for direct catalog authoring; issue deliberately.

## library_update_skill

Create a revision with partial changed files.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `name` | Yes | Catalog slug/name. |
| `files` | Yes | Nonempty file array. Each file is `{path, content, encoding?}`: path and content required; encoding is `utf8` or `base64` (omitted means text). Paths are inside the package. |
| `remove` | No | File paths to remove; default empty. |
| `note` | No | Revision note; default empty. |

**Authority and scope:** Skills token with `manage` scope.

**Result:** JSON ok, name, changed, revision or null, and published state.

**Restrictions:** Unnamed files remain. Missing/deleted packages and non-writable ownership fail. A manage token does not bypass source editability rules.

## library_export

Export effective shared-revision manifests for a peer.

**Arguments:** none.

**Authority and scope:** Skills token with `sync` scope.

**Result:** JSON items with slug, metadata, revision, content hash, version, category and source_path; source ID/kind/label metadata.

**Restrictions:** Exports eligible shared packages with effective revisions; does not apply browsing-only discoverability filtering and does not export personal packages. Hashes let peers skip unchanged content.

## library_export_skill

Export a full effective shared package.

| Argument | Required | Meaning and default |
| --- | --- | --- |
| `name` | Yes | Catalog slug/name. |

**Authority and scope:** Skills token with `sync` scope.

**Result:** JSON slug, revision, hash and file array containing path, base64 content, executable flag.

**Restrictions:** Rejects missing/deleted/personal packages or absent approved revisions. Used for catalog peer synchronization, not external file-upload staging.

## Related guides

[External library guide](/docs/features/skills-library-mcp), [sources](/docs/features/skill-synchronization), [reviews](/docs/features/skill-reviews), and [conversation skill controls](/docs/controls/skills).
