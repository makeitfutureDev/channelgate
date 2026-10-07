---
title: Skills library for external assistants
description: Expose the governed catalog to laptops and peer gateways through a scoped MCP endpoint.
---

The skills library endpoint lets an external MCP client reuse this gateway's catalog without an admin browser session. It is separate from the per-run gateway control server and cannot reach the admin API.

## Connect a client

Administrators open **Admin → Skills → MCP → MCP access**, configure the gateway's public URL, and mint a named access token. The secret token is shown once and stored as a hash. Connect a compatible Streamable HTTP client to:

```text
https://gateway.example.com/mcp/skills
Authorization: Bearer <skills-access-token>
```

Use HTTPS and the client's secure credential storage. The endpoint is stateless and accepts **POST**; GET and DELETE return 405. Revoking the token blocks subsequent requests.

## Grant only the needed scopes

| Scope | Capabilities |
| --- | --- |
| `read` | Search, inspect files and metadata, list templates |
| `propose` | Submit changes or feedback for review |
| `manage` | Create and update local packages |
| `sync` | Export package manifests and files for peer gateways |

These scopes are independent. `library_whoami` reports the authenticated token's metadata and scopes without its secret value. A token with no selected scopes defaults to `read` when minted.

Read tools expose discoverable non-personal skills. The sync interface exports eligible shared effective revisions, including packages needed by a peer, rather than the browsing-only discoverability filter. Neither exports personal packages.

## Use the library

An external assistant can search for a report workflow, read its entry point, and propose an improvement. A `manage` token can author local skills directly, so issue it only when those writes are intended. A peer source uses `sync` for content-hash manifests followed by complete package files.

The HTTP JSON body limit is 20 MB. Library text responses are bounded to 60,000 characters. Binary file reads return a JSON envelope with base64; gateway chat inspection instead describes binary content.

Related: [sources](/docs/features/skill-synchronization), [review](/docs/features/skill-reviews), and the [ten library controls](/docs/controls/skills-library).
