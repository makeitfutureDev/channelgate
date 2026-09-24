// The two MCP tools that get a file out of a channel folder, and the approval gate around the one
// that publishes.
//
// What this file holds down:
//   • `stage_file_for_composio` spends the identity the caller NAMED — a file staged for
//     composio-user must not be staged with the agent's key — and says so plainly when that
//     identity has no key
//   • it refuses a path outside the channel folder before any key is spent
//   • `create_public_file_link` is refused entirely while the gateway switch is off or no Public
//     URL is set, so the feature is dormant on a default install
//   • the duration rules reach the model as errors it can act on: a share link with no duration is
//     told to ask, and one over 48 hours is told the ceiling
//   • the control-plane gate cards a `share` link (naming the file AND the duration) and
//     deliberately does NOT card an `upload` one
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { ensureTestEnv } from "./helpers.js";

const scratch = ensureTestEnv();

const { register, describeDuration } = await import("../src/mcp/tools/file-sharing.js");
const { buildControlPlane } = await import("../src/mcp/gateway-server.js");
const { saveSettings } = await import("../src/config/settings.js");
const { setUser } = await import("../src/config/store.js");
const { listPublicFileLinks } = await import("../src/gateway/public-file-links.js");

const SLUG = "file-sharing-test";
const CHANNEL = "C_FILESHARE";
const WORKDIR = path.join(process.env.CG_WORKSPACE_DIR, "slack", SLUG);
mkdirSync(path.join(WORKDIR, "work"), { recursive: true });
writeFileSync(path.join(WORKDIR, "work", "PROPOSAL.pdf"), "%PDF-1.7 proposal\n");
// A file the channel can read but must not be able to publish or stage.
mkdirSync(path.join(scratch, "elsewhere"), { recursive: true });
writeFileSync(path.join(scratch, "elsewhere", "secret.txt"), "not yours");

// A stub standing in for Composio, so the tool's real staging path is exercised on both routes:
// the REST upload API (project API keys) and the hosted MCP's workbench (consumer `ck_` keys —
// what this gateway actually stores). The workbench half reassembles the appended base64 chunks
// per sandbox path and answers the final md5 check the way the real sandbox prints it.
const staged = [];
const sandbox = new Map();
function workbenchReply(code) {
  const target = (code.match(/open\('([^']+)'/) || [])[1] || "";
  const chunk = (code.match(/b64decode\('([^']*)'\)/) || [])[1];
  if (chunk !== undefined) {
    const prior = code.includes("'wb'") ? Buffer.alloc(0) : (sandbox.get(target) || Buffer.alloc(0));
    sandbox.set(target, Buffer.concat([prior, Buffer.from(chunk, "base64")]));
    return "";
  }
  const data = sandbox.get(target) || Buffer.alloc(0);
  const md5 = createHash("md5").update(data).digest("hex");
  return `CGSTAGE${JSON.stringify({ md5, bytes: data.length, s3key: `workbench/staged/${path.basename(target)}` })}\n`;
}
const composio = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    if (req.url.startsWith("/mcp")) {
      const rpc = JSON.parse(body || "{}");
      staged.push({ url: req.url, method: rpc.method, key: req.headers["x-consumer-api-key"], body });
      res.setHeader("mcp-session-id", "stub-session");
      if (rpc.id === undefined) return res.end("");
      const result = rpc.method === "tools/call"
        ? { content: [{ type: "text", text: JSON.stringify({ data: { stdout: workbenchReply(rpc.params.arguments.code_to_execute), error: "" }, successful: true }) }] }
        : { protocolVersion: "2025-03-26", capabilities: {} };
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    }
    staged.push({ url: req.url, method: req.method, key: req.headers["x-api-key"], body });
    res.end(JSON.stringify(req.url.includes("/files/upload/request")
      ? { key: "org/staged/PROPOSAL.pdf", new_presigned_url: `http://127.0.0.1:${composio.address().port}/put` }
      : {}));
  });
});
await new Promise((resolve) => composio.listen(0, "127.0.0.1", resolve));
process.env.COMPOSIO_API_BASE = `http://127.0.0.1:${composio.address().port}`;
process.env.COMPOSIO_MCP_URL = `http://127.0.0.1:${composio.address().port}/mcp`;
test.after(() => composio.close());

function tools({ author = "U_AUTHOR", meta = {}, stageFile } = {}) {
  const map = new Map();
  register({ registerTool: (name, _schema, handler) => map.set(name, handler) }, {
    channelId: CHANNEL,
    slug: SLUG,
    createdBy: author,
    text: (t) => t,
    loadMeta: async () => ({ platform: "slack", isDM: false, ...meta }),
    ...(stageFile ? { stageFile } : {}),
  });
  return map;
}

test("a consumer key stages through the Composio workbench on the named identity's key", async () => {
  staged.length = 0;
  await setUser("U_AUTHOR", { name: "Author", approved: true, composioToken: "ck_personal" });
  const reply = await tools({ meta: { composioToken: "ck_channel" } }).get("stage_file_for_composio")({
    path: "work/PROPOSAL.pdf",
    tool: "GOOGLEDRIVE_UPLOAD_FILE",
    identity: "user",
  });

  assert.match(reply, /Staged `work\/PROPOSAL\.pdf`/);
  assert.match(reply, /"s3key": "workbench\/staged\/PROPOSAL\.pdf"/);
  assert.match(reply, /"mimetype": "application\/pdf"/);
  // Consumer keys are the hosted MCP's credential: the REST upload API rejects them, so nothing
  // may be sent there — every request is a JSON-RPC call to the MCP endpoint.
  assert.ok(staged.length >= 3 && staged.every((call) => call.url.startsWith("/mcp")), "consumer keys never hit the REST API");
  // "user" must spend the PERSONAL key, never the channel's — a file staged on one is invisible
  // to the other, and silently substituting identities is the bug this asserts against.
  assert.ok(staged.every((call) => call.key === "ck_personal"));

  staged.length = 0;
  const agentReply = await tools({ meta: { composioToken: "ck_channel" } }).get("stage_file_for_composio")({
    path: "work/PROPOSAL.pdf",
    tool: "GOOGLEDRIVE_UPLOAD_FILE",
    identity: "agent",
  });
  assert.match(agentReply, /composio-agent/);
  assert.ok(staged.every((call) => call.key === "ck_channel"));
});

test("the tool hands staging the proven descriptor, never a path to reopen", async () => {
  // The confinement proof is only worth something if the bytes come from the descriptor it proved:
  // the container can write this folder, so a path reopened after the proof could by then be a
  // symlink (or sit under a swapped parent directory) pointing anywhere the daemon can read.
  await setUser("U_AUTHOR", { name: "Author", approved: true, composioToken: "ck_personal" });
  let seen = null;
  const reply = await tools({
    stageFile: async (options) => {
      const bytes = Buffer.alloc(64);
      const { bytesRead } = await options.handle.read(bytes, 0, 64, 0);
      seen = { ...options, content: bytes.subarray(0, bytesRead).toString(), fd: typeof options.handle?.fd };
      return { file: { name: "PROPOSAL.pdf", mimetype: "application/pdf", s3key: "k" }, bytes: bytesRead, deduplicated: false, tool: "GOOGLEDRIVE_UPLOAD_FILE", route: "workbench" };
    },
  }).get("stage_file_for_composio")({ path: "work/PROPOSAL.pdf", tool: "GOOGLEDRIVE_UPLOAD_FILE", identity: "user" });
  assert.match(reply, /Staged `work\/PROPOSAL\.pdf`/);
  assert.equal(seen.fd, "number", "a live descriptor reaches staging");
  assert.equal(seen.absolutePath, undefined, "no path is handed over to be reopened");
  assert.equal(seen.content, readFileSync(path.join(WORKDIR, "work", "PROPOSAL.pdf"), "utf8"), "and it is the proven file");
});

test("a project API key keeps the REST upload route", async () => {
  staged.length = 0;
  await setUser("U_PROJECT", { name: "Project", approved: true, composioToken: "ak_project" });
  const reply = await tools({ author: "U_PROJECT" }).get("stage_file_for_composio")({
    path: "work/PROPOSAL.pdf",
    tool: "GOOGLEDRIVE_UPLOAD_FILE",
    identity: "user",
  });
  assert.match(reply, /"s3key": "org\/staged\/PROPOSAL\.pdf"/);
  assert.equal(staged[0].key, "ak_project");
  assert.equal(JSON.parse(staged[0].body).tool_slug, "GOOGLEDRIVE_UPLOAD_FILE");
  assert.equal(staged[1].method, "PUT");
});

test("an upstream failure is reported as a failure, not as a refusal", async () => {
  staged.length = 0;
  process.env.COMPOSIO_MCP_URL = "http://127.0.0.1:9/unreachable";
  try {
    const reply = await tools({ meta: { composioToken: "ck_channel" } }).get("stage_file_for_composio")({
      path: "work/PROPOSAL.pdf",
      tool: "GOOGLEDRIVE_UPLOAD_FILE",
      identity: "agent",
    });
    // "Refused" is reserved for the confinement check; the model reads it as a policy decision
    // and, on a 401, told the user their own key was invalid.
    assert.match(reply, /^Staging failed:/);
    assert.ok(!reply.includes("ck_channel"), "the key never appears in the reply");
  } finally {
    process.env.COMPOSIO_MCP_URL = `http://127.0.0.1:${composio.address().port}/mcp`;
  }
});

test("staging names the missing identity instead of falling back to the other one", async () => {
  staged.length = 0;
  await setUser("U_NOKEY", { name: "Nokey", approved: true, composioToken: "" });
  const reply = await tools({ author: "U_NOKEY", meta: { composioToken: "ck_channel" } }).get("stage_file_for_composio")({
    path: "work/PROPOSAL.pdf",
    tool: "GOOGLEDRIVE_UPLOAD_FILE",
    identity: "user",
  });
  assert.match(reply, /No Composio API key is available for `composio-user`/);
  assert.match(reply, /set_my_composio_token/);
  assert.equal(staged.length, 0, "no key must be spent when the named identity has none");
});

test("staging refuses a path outside the channel folder before spending a key", async () => {
  staged.length = 0;
  const reply = await tools().get("stage_file_for_composio")({
    path: "../../elsewhere/secret.txt",
    tool: "GOOGLEDRIVE_UPLOAD_FILE",
    identity: "user",
  });
  assert.match(reply, /Staging refused/);
  assert.ok(!reply.includes("not yours"));
  assert.equal(staged.length, 0);
});

test("public links are refused while the gateway switch is off, and without a Public URL", async () => {
  await saveSettings({ publicFileLinksEnabled: false, publicUrl: "https://gw.example.test" });
  const off = await tools().get("create_public_file_link")({ path: "work/PROPOSAL.pdf", purpose: "upload" });
  assert.match(off, /turned off on this gateway/);
  // The refusal points at the capability that needs no link at all.
  assert.match(off, /stage_file_for_composio/);

  await saveSettings({ publicFileLinksEnabled: true, publicUrl: "" });
  assert.match(
    await tools().get("create_public_file_link")({ path: "work/PROPOSAL.pdf", purpose: "upload" }),
    /need the gateway's Public URL/,
  );
});

test("an upload link is short, capped and told not to be posted", async () => {
  await saveSettings({ publicFileLinksEnabled: true, publicUrl: "https://gw.example.test" });
  const reply = await tools().get("create_public_file_link")({ path: "work/PROPOSAL.pdf", purpose: "upload" });

  assert.match(reply, /live 5 minutes/);
  assert.match(reply, /https:\/\/gw\.example\.test\/f\/[A-Za-z0-9_-]{40,}/);
  assert.match(reply, /do not post it in the conversation/);
  assert.match(reply, /5 fetches/);
});

test("a share link must state a duration, and 48 hours is the ceiling", async () => {
  await saveSettings({ publicFileLinksEnabled: true, publicUrl: "https://gw.example.test" });
  const t = tools();

  const noDuration = await t.get("create_public_file_link")({ path: "work/PROPOSAL.pdf", purpose: "share" });
  assert.match(noDuration, /needs an explicit duration in minutes — ask how long/);

  const tooLong = await t.get("create_public_file_link")({ path: "work/PROPOSAL.pdf", purpose: "share", minutes: 10080 });
  assert.match(tooLong, /at most 2880 minutes \(48 hours\); 10080 was requested/);

  const ok = await t.get("create_public_file_link")({ path: "work/PROPOSAL.pdf", purpose: "share", minutes: 1440 });
  assert.match(ok, /live 24 hours/);
  assert.match(ok, /Anyone with this URL can download the file until it expires, with no login/);
  assert.match(ok, /revoke_public_file_link/);
});

test("links are listed and revoked within the channel only", async () => {
  await saveSettings({ publicFileLinksEnabled: true, publicUrl: "https://gw.example.test" });
  const t = tools();
  await t.get("create_public_file_link")({ path: "work/PROPOSAL.pdf", purpose: "share", minutes: 60 });

  const listed = await t.get("list_public_file_links")({});
  assert.match(listed, /work\/PROPOSAL\.pdf/);
  // The URL itself is unrecoverable once minted — only the id is.
  assert.ok(!/\/f\/[A-Za-z0-9_-]{40,}/.test(listed));

  const id = listPublicFileLinks(CHANNEL)[0].id;
  assert.match(await t.get("revoke_public_file_link")({ id }), /Revoked `work\/PROPOSAL\.pdf`/);
  assert.match(await t.get("revoke_public_file_link")({ id: "00000000-0000-0000-0000-000000000000" }), /No such link in this channel/);
});

test("a public path that escapes the channel folder never becomes a link", async () => {
  await saveSettings({ publicFileLinksEnabled: true, publicUrl: "https://gw.example.test" });
  const reply = await tools().get("create_public_file_link")({ path: "../../elsewhere/secret.txt", purpose: "upload" });
  assert.match(reply, /Public link refused/);
  assert.ok(!listPublicFileLinks(CHANNEL).some((l) => l.relative.includes("secret")));
});

test("the control plane cards a share link and lets an upload link through", async () => {
  const plane = buildControlPlane({ loadMeta: async () => ({}) });
  const gate = plane.get("create_public_file_link");
  assert.ok(gate, "create_public_file_link must be gated");
  assert.equal(gate.authz, "any");

  // An upload link is a build step inside work the user already asked for: no card.
  assert.equal(await gate.details({ path: "work/PROPOSAL.pdf", purpose: "upload" }), null);

  const card = await gate.details({ path: "work/PROPOSAL.pdf", purpose: "share", minutes: 1440 });
  assert.match(card, /Publish `work\/PROPOSAL\.pdf`/);
  assert.match(card, /24 hours/);
  assert.match(card, /no login/);

  // A share call with no duration still shows a card rather than slipping past the gate; the
  // handler then refuses it.
  assert.match(await gate.details({ path: "x.pdf", purpose: "share" }), /unspecified duration/);
});

test("durations read the way a person would say them", () => {
  assert.equal(describeDuration(1), "1 minute");
  assert.equal(describeDuration(5), "5 minutes");
  assert.equal(describeDuration(60), "1 hour");
  assert.equal(describeDuration(1440), "24 hours");
  assert.equal(describeDuration(90), "1.5 hours");
});
