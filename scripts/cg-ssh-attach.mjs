#!/usr/bin/env node
// cg-ssh-attach — the forced command behind the gateway host's dedicated SSH login account
// (docs/SSH-ACCESS.md). sshd runs it for every accepted connection; it hands the developer's SSH
// byte stream to the daemon's attach socket and copies bytes both ways until either side hangs up.
// It decides NOTHING: the daemon authorizes the key, the user and the channel grant. It is
// installed by scripts/install-ssh-access.sh as a root-owned copy under /usr/local/lib/channelgate
// (the login account cannot read the checkout), so it must stay SELF-CONTAINED — no imports from
// src/. It runs as an unprivileged account with no home, no shell of its own and no container
// access; even a bug here reaches nothing.
import net from "node:net";
import path from "node:path";
import { readFileSync } from "node:fs";

const dir = process.env.CHANNELGATE_SSH_DIR || "/var/lib/channelgate-ssh";
const socketPath = path.join(dir, "attach.sock");

function fail(message, code = 1) {
  process.stderr.write(`channelgate: ${message}\n`);
  process.exit(code);
}

// Which key authenticated: sshd exposes it in the SSH_USER_AUTH file (ExposeAuthInfo yes). The
// key id on the authorized_keys line (argv) is the fallback for an sshd without that option.
let key = "";
if (process.env.SSH_USER_AUTH) {
  try {
    const line = readFileSync(process.env.SSH_USER_AUTH, "utf8").split("\n").find((entry) => entry.startsWith("publickey "));
    if (line) key = line.slice("publickey ".length).trim();
  } catch {
    /* fall back to the key id */
  }
}
const keyId = String(process.argv[2] || "").trim();
if (!key && !keyId) fail("sshd did not expose which key authenticated (ExposeAuthInfo yes is required in the Match block)");

// Which channel: the first word of the client's command (`ssh cg@host acme-project`, or the
// ProxyCommand's trailing argument in the developer's ssh config).
const original = String(process.env.SSH_ORIGINAL_COMMAND || "").trim();
const channel = original.split(/\s+/)[0] || "";
if (!channel) fail("name the channel to attach to — `ssh <account>@<host> <channel-slug>`, or use the ssh config block the assistant gave you", 2);
const client = String(process.env.SSH_CONNECTION || "").split(" ")[0] || "";

const socket = net.connect(socketPath);
socket.on("error", (error) => fail(`the gateway attach socket is unavailable (${error?.code || error?.message || error}) — is the ChannelGate daemon running?`));
socket.once("connect", () => {
  socket.write(`${JSON.stringify({ v: 1, key, keyId, channel, client, command: original })}\n`);
});

// The daemon answers with one JSON line; only after an ok does the raw SSH stream begin, and from
// then on nothing but that stream may touch stdout.
const chunks = [];
const onData = (chunk) => {
  const nl = chunk.indexOf(0x0a);
  if (nl === -1) {
    chunks.push(chunk);
    return;
  }
  socket.removeListener("data", onData);
  chunks.push(chunk.subarray(0, nl));
  let status;
  try {
    status = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("the gateway sent an unreadable attach reply");
  }
  if (!status?.ok) fail(status?.error || "the gateway refused the attach");
  const rest = chunk.subarray(nl + 1);
  if (rest.length) process.stdout.write(rest);
  socket.pipe(process.stdout);
  process.stdin.pipe(socket);
};
socket.on("data", onData);
socket.once("close", () => process.exit(0));
process.stdin.once("end", () => socket.end());
process.stdout.on("error", () => process.exit(0)); // the ssh client went away (EPIPE)
