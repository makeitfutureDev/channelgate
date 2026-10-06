---
title: SSH access controls
description: Reference for personal public keys, conversation grants, and connection status.
---

SSH gives a person a full interactive shell inside a conversation’s shared container. These tools use the verified requester identity. Personal key changes and manager grant changes require a human control-plane approval; Auto does not replace that decision. Host SSH setup is separate from key registration. See [SSH access](/docs/features/ssh-access) and [VS Code](/docs/features/vscode-access).

## add_my_ssh_key

**Required:** `public_key` (the single public-key line). **Optional:** `label` (string).

```json
{
  "public_key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA example-laptop",
  "label": "Work laptop"
}
```

**Scope and result:** Registers a key only for the trusted requesting approved user or administrator. Returns key fingerprint, family, label, and whether host export succeeded. Registration alone does not grant access to any conversation.

**Limits:** Only public keys; never private key material. Accepted families include ED25519, supported ECDSA and security-key forms, and RSA of at least 2,048 bits. DSA, malformed blobs, and multiline input are refused. The example demonstrates argument shape; replace it with your actual `.pub` line.

## list_my_ssh_keys

**Arguments:** none.

```json
{}
```

**Scope and result:** Lists the requesting user’s registered key IDs, fingerprints, types, labels, added time, and last-use time. It never lists another person’s keys.

**Limits:** No user selector is accepted. A missing user context or no registered keys produces a explicit notice.

## remove_my_ssh_key

**Required:** `key` (your key fingerprint such as `SHA256:…`, or registered key ID).

```json
{
  "key": "SHA256:example-fingerprint"
}
```

**Scope and result:** Removes a matching key belonging to the requesting person and refreshes host authorized-key export. Returns the removed fingerprint or a no-match notice.

**Limits:** New connections using that key stop working across every conversation grant. Already open sessions end when they disconnect; this tool is not a force-disconnect command.

## grant_channel_ssh

**Required:** `user` (gateway user ID or supported mention).

```json
{
  "user": "UEXAMPLEUSER"
}
```

**Scope and result:** Requires a current conversation manager or administrator and a human approval at that tier. Saves the person in this conversation’s SSH grant list and reports any outstanding setup/key conditions.

**Limits:** The target must be an approved gateway user or administrator and independently authorized to connect to this conversation. A grant can be saved before a key exists, but the key and host setup are still required to connect. Connections remain refused under the applicable Admin plus operator-home-mount policy.

## revoke_channel_ssh

**Required:** `user` (gateway user ID or supported mention).

```json
{
  "user": "UEXAMPLEUSER"
}
```

**Scope and result:** Requires a conversation manager or administrator and a human approval. Removes the conversation SSH grant and returns whether any open sessions remain.

**Limits:** New connections are refused immediately. Existing sessions end when they disconnect. This does not remove the person’s globally registered public key or other conversation grants.

## show_channel_ssh

**Arguments:** none.

```json
{}
```

**Scope and result:** Read-only connection/status view for a requester authorized in this conversation. Returns host setup state, granted people, registered-key readiness, live sessions, the SSH config block, and the working-folder/VS Code command when setup permits.

**Limits:** A displayed snippet is not a access grant. The broker rechecks the key, user approval, conversation authorization/grant, and operator-home restriction on connection. The container stays leased while a SSH session is live; daemon restart drops it. All people in the container share its operating-system user, so set Git identity and coordinate edits.
