// A run capability is authority only while its conversation has live work (security audit,
// roadmap item 3). The daemon's control socket re-checks the egress liveness registry on the hello
// and on every tool call: a validly signed, unexpired token whose channel has no live turn, job,
// review or SSH session is refused with one fixed sentence, after a short post-release grace.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestEnv, trackTempDir } from "./helpers.js";

ensureTestEnv();
process.env.CG_APPROVAL_SECRET = "capability-liveness-secret";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

const { mintGatewayCapability, verifyGatewayCapability } = await import("../src/gateway/mcp-capability.js");
const { markLive, __resetLiveness, __setSshSessionSource } = await import("../src/gateway/egress/liveness.js");
const { CAPABILITY_IDLE_REASON, CAPABILITY_GRACE_MS, capabilityChannelLive, withCapabilityLiveness, __resetCapabilityLivenessLog } = await import("../src/gateway/capability-liveness.js");
const { startMcpSocketServer, stopMcpSocketServer } = await import("../src/mcp/socket-server.js");
const { registerRemoteMcps, clearRemoteMcps, authorizeRemoteMcp } = await import("../src/mcp/remote-mcp-registry.js");

const SECRET = "capability-liveness-secret";
const CHANNEL = "C_CAP_LIVE";
const SLUG = "cap-live";
const AUTHOR = "U_CAP_LIVE";

const mint = (extra = {}) => mintGatewayCapability({
  secret: SECRET, channelId: CHANNEL, slug: SLUG, authorId: AUTHOR, threadKey: "1700000000.000200",
  origin: "slack_foreground", engine: "claude", ...extra,
});

function rawExchange(socketPath, line) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let out = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(line));
    socket.on("data", (chunk) => { out += chunk; });
    socket.on("close", () => resolve(out));
    socket.on("error", reject);
  });
}

async function serverOn(t) {
  const dir = trackTempDir(mkdtempSync("/tmp/cgcap-"));
  const socketPath = path.join(dir, "mcp.sock");
  const active = await startMcpSocketServer({ handlers: {}, socketPath, dir, log: { log() {}, warn() {} } });
  assert.ok(active);
  t.after(() => stopMcpSocketServer());
  return socketPath;
}

const hello = (cap) => `${JSON.stringify({ channelgate: "hello", v: 1, service: "gateway", cap })}\n`;

test.beforeEach(() => {
  __resetLiveness();
  __resetCapabilityLivenessLog();
  __setSshSessionSource(() => []);
});

test("the liveness-aware verifier passes while the channel is live, refuses once it is idle, and audits once per minute", () => {
  const cap = mint();
  const logged = [];
  let clock = Date.now();
  const verify = withCapabilityLiveness(() => verifyGatewayCapability(cap, { secret: SECRET, now: clock }), { now: () => clock, log: async (event, fields) => logged.push({ event, fields }) });

  // Nothing live, nothing recently released: refused with the fixed sentence.
  let result = verify({ tool: "list_secrets" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, CAPABILITY_IDLE_REASON);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].event, "capability_refused_idle");
  assert.equal(logged[0].fields.channel, CHANNEL);
  assert.equal(logged[0].fields.tool, "list_secrets");
  assert.ok(logged[0].fields.jti, "the audit row names the token id");
  assert.equal(JSON.stringify(logged[0]).includes(cap), false, "never the token");
  verify({ tool: "list_secrets" });
  assert.equal(logged.length, 1, "a tight retry loop does not flood the events table");

  // A live turn in the channel admits the call; the signature failures still win over liveness.
  const release = markLive({ channelId: CHANNEL, ownerId: AUTHOR, kind: "turn", id: "t1" });
  assert.equal(verify({ tool: "list_secrets" }).ok, true);
  const bad = withCapabilityLiveness(() => verifyGatewayCapability(cap, { secret: "other" }), { now: () => clock, log: async () => {} })();
  assert.match(bad.reason, /signature/);

  // Released: the grace window still admits an in-flight call, then the refusal returns.
  release();
  assert.equal(verify({ tool: "update_channel_memory" }).ok, true, "inside the post-release grace");
  clock += CAPABILITY_GRACE_MS + 5_000; // past the grace even after the real milliseconds this test took
  result = verify({ tool: "update_channel_memory" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, CAPABILITY_IDLE_REASON);
});

test("a background job, a memory review or an SSH session keeps the channel live after the turn ended", () => {
  const now = Date.now();
  const releaseTurn = markLive({ channelId: CHANNEL, ownerId: AUTHOR, kind: "turn", id: "t2" });
  const releaseJob = markLive({ channelId: CHANNEL, ownerId: AUTHOR, kind: "job", id: "job-1" });
  releaseTurn();
  assert.equal(capabilityChannelLive(CHANNEL, { now: now + CAPABILITY_GRACE_MS + 60_000 }), true, "the job alone keeps it live");
  releaseJob();
  assert.equal(capabilityChannelLive(CHANNEL, { now: now + CAPABILITY_GRACE_MS + 60_000 }), false);
  const releaseReview = markLive({ channelId: CHANNEL, ownerId: "", kind: "review", id: "r1" });
  assert.equal(capabilityChannelLive(CHANNEL, { now: now + 120_000 }), true);
  releaseReview();
  __setSshSessionSource(() => [{ channelId: CHANNEL, userId: AUTHOR }]);
  assert.equal(capabilityChannelLive(CHANNEL, { now: now + 120_000 }), true, "an SSH session is live work");
  __setSshSessionSource(() => []);
  // Another channel's work never vouches for this one.
  const other = markLive({ channelId: "C_OTHER", ownerId: AUTHOR, kind: "turn", id: "t3" });
  assert.equal(capabilityChannelLive(CHANNEL, { now: now + 120_000 }), false);
  other();
});

test("the control socket refuses an idle channel's capability on the hello and admits it while live", async (t) => {
  const socketPath = await serverOn(t);
  const cap = mint();
  let answer = await rawExchange(socketPath, hello(cap));
  let frame = JSON.parse(answer.trim());
  assert.equal(frame.channelgate, "error");
  assert.ok(frame.reason.includes(CAPABILITY_IDLE_REASON), frame.reason);

  const release = markLive({ channelId: CHANNEL, ownerId: AUTHOR, kind: "turn", id: "t4" });
  t.after(release);
  // While live the hello is accepted: the server attaches the MCP transport and waits for the
  // stream, so a client that writes nothing more sees no error frame at all.
  const accepted = await new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let out = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(hello(cap));
      setTimeout(() => socket.destroy(), 300);
    });
    socket.on("data", (chunk) => { out += chunk; });
    socket.on("close", () => resolve(out));
    socket.on("error", reject);
  });
  assert.equal(accepted.includes("\"error\""), false, accepted);
});

test("the remote-mcp registry is untouched: a jti registration still authorizes while the channel is live", () => {
  const release = markLive({ channelId: CHANNEL, ownerId: AUTHOR, kind: "turn", id: "t5" });
  const cap = mint({ remoteMcps: ["crm"], jti: "cap-live-jti-000001" });
  const checked = verifyGatewayCapability(cap, { secret: SECRET });
  registerRemoteMcps({ jti: "cap-live-jti-000001", exp: checked.claims.exp, servers: { crm: { url: "https://mcp.example.test/mcp", headers: { authorization: "Bearer x" } } } });
  assert.equal(authorizeRemoteMcp(checked, "crm").url, "https://mcp.example.test/mcp");
  clearRemoteMcps("cap-live-jti-000001");
  release();
});

test("every spawn path registers its channel as live before its first tool call", () => {
  // Foreground, API, scheduled, loop/followup/nudge, diagnosis and host turns all run through
  // src/gateway/run.js, which marks the turn live right after taking the runtime lease and
  // releases it in the finally; background jobs/agents, memory reviews and the update smoke have
  // their own registration; SSH sessions are read from the broker. This pins each of them.
  const run = read("src/gateway/run.js");
  assert.match(run, /releaseEgressLive = markLive\(\{ channelId, ownerId: untrustedPrincipal \? "" : authorId, kind: "turn", id: threadKey \}\);\n\s+await bringRuntimeUp\(\);/);
  assert.match(run, /finally \{[\s\S]*releaseEgressLive\?\.\(\);/);
  const background = read("src/gateway/background.js");
  assert.match(background, /rec\.releaseLive = markLive\(\{ channelId, ownerId: authorId, kind: "job", id: runId \}\)/);
  assert.match(background, /rec\.releaseLive = markLive\(\{ channelId: rec\.channelId, ownerId: rec\.authorId, kind: "job"/, "a recovered job re-marks itself");
  assert.match(read("src/gateway/memory-review.js"), /markLive\(\{ channelId, ownerId: "", kind: "review", id: reviewRunId \}\)/);
  assert.match(read("src/gateway/update-smoke.js"), /markLive\(\{ channelId: target\.meta\?\.channelId, kind: "turn", id: target\.slug \}\)/);
  assert.match(read("src/gateway/egress/liveness.js"), /import \{ liveSshSessions \} from "\.\.\/ssh-broker\.js"/);
  // Every daemon-originated turn enters through run.js.
  for (const file of ["src/gateway/api-runs.js", "src/gateway/scheduler.js", "src/platforms/ingest.js", "src/slack/message-pipeline.js", "src/gateway/background.js", "src/gateway/diagnosis.js"]) {
    assert.match(read(file), /from "(\.\.\/gateway\/run\.js|\.\/run\.js)"/, file);
  }
  // The socket verifies liveness on the hello and hands the same verifier to every tool call.
  const socket = read("src/mcp/socket-server.js");
  assert.match(socket, /const verify = withCapabilityLiveness\(\(\) => verifyGatewayCapability\(cap, \{ secret: secret\(\) \}\)\);/);
  assert.match(read("src/mcp/gateway-server.js"), /ctx\.verifyCapability\(\{ tool: name \}\)/);
});
