import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureTestEnv } from "./helpers.js";
import { CAPABILITY_SPEC, validatePlatformAdapter, createPlatformRegistry } from "../src/platforms/contract.js";
import {
  PLATFORM_IDS, DEFAULT_PLATFORM, platformSupports, capabilitiesFor, formatOutboundFor,
  livePlatformIds, platformOr, isPlatformId, platformStatus, platformUiManifest,
} from "../src/platforms/registry.js";
import { qualifyConversationId, parseConversationId, normalizePlatformId } from "../src/platforms/ids.js";
import { degradeMarkdown, tablesToFixedWidth, chunkText, splitFences } from "../src/platforms/format/degrade.js";
import { formatChatOutbound } from "../src/platforms/format/gchat.js";
import { formatTeamsOutbound } from "../src/platforms/format/teams.js";
import { createNullConnector, postFormatted } from "../src/platforms/connector.js";
import { postNotice, postDirectMessage, asConnector } from "../src/platforms/notify.js";

ensureTestEnv();

const base = () => ({
  id: "probe", label: "Probe", idPrefix: "probe:", folderName: "probe", transport: "test", status: "scaffold",
  conversationKinds: ["channel"], capabilities: {},
  formatOutbound: () => ({ text: "", chunks: [] }),
  createConnector: () => null,
  health: async () => ({ ready: false }),
});

// ── contract ──────────────────────────────────────────────────────────────────

test("an undeclared capability falls to the LEAST capable default, never to Slack's", () => {
  const adapter = validatePlatformAdapter(base());
  for (const [key, spec] of Object.entries(CAPABILITY_SPEC)) {
    assert.equal(adapter.capabilities[key], spec.default, `${key} should default to ${spec.default}`);
  }
  // Spot-check the ones a "default to permissive" bug would silently enable.
  assert.equal(adapter.capabilities.broadcast, false);
  assert.equal(adapter.capabilities.ephemeral, false);
  assert.equal(adapter.capabilities.markdownTables, false);
});

test("a misspelled capability is a validation error, not a silent false", () => {
  assert.throws(
    () => validatePlatformAdapter({ ...base(), capabilities: { markdownTable: true } }),
    /unknown capability "markdownTable"/,
  );
});

test("capability values and types are enforced", () => {
  assert.throws(() => validatePlatformAdapter({ ...base(), capabilities: { threading: "sorta" } }), /threading/);
  assert.throws(() => validatePlatformAdapter({ ...base(), capabilities: { editsPerSecond: -1 } }), /editsPerSecond/);
  assert.throws(() => validatePlatformAdapter({ ...base(), capabilities: { ephemeral: "yes" } }), /must be a boolean/);
});

test("internally inconsistent reply modes are rejected", () => {
  assert.throws(
    () => validatePlatformAdapter({ ...base(), capabilities: { nativeStreaming: true } }),
    /nativeStreaming requires messageEdit/,
  );
  assert.throws(
    () => validatePlatformAdapter({ ...base(), capabilities: { messageEdit: true, editsPerSecond: 0 } }),
    /positive editsPerSecond/,
  );
  assert.throws(
    () => validatePlatformAdapter({ ...base(), capabilities: { buttons: true, modals: true } }),
    /require a richCards primitive/,
  );
  assert.throws(
    () => validatePlatformAdapter({ ...base(), capabilities: { mixedThreading: true } }),
    /mixedThreading only makes sense/,
  );
});

test("a required manifest field or method missing fails validation", () => {
  const { transport, ...noTransport } = base();
  assert.throws(() => validatePlatformAdapter(noTransport), /missing transport/);
  const { formatOutbound, ...noFormat } = base();
  assert.throws(() => validatePlatformAdapter(noFormat), /missing formatOutbound/);
  assert.throws(() => validatePlatformAdapter({ ...base(), status: "someday" }), /unknown status/);
});

test("idPrefix may be empty but must be unique and unambiguous", () => {
  assert.doesNotThrow(() => validatePlatformAdapter({ ...base(), idPrefix: "" }));
  assert.throws(() => validatePlatformAdapter({ ...base(), idPrefix: "Probe:" }), /idPrefix must look like/);
  assert.throws(
    () => createPlatformRegistry([base(), { ...base(), id: "other" }]),
    /share the id prefix/,
  );
  // The enforced "name:" shape is what makes parseConversationId unambiguous: a colon terminates
  // every prefix and cannot occur inside one, so two distinct prefixes are never prefixes of one
  // another. Uniqueness is therefore the only check needed.
  assert.doesNotThrow(() => createPlatformRegistry([base(), { ...base(), id: "other", idPrefix: "pro:" }]));
  assert.equal(parseConversationId("probe:x").platform, DEFAULT_PLATFORM); // unregistered prefix → Slack
});

// ── registry ──────────────────────────────────────────────────────────────────

test("the built-in platforms are registered, Slack is the default, and all three have a transport", () => {
  assert.deepEqual(PLATFORM_IDS, ["slack", "googlechat", "msteams"]);
  assert.equal(DEFAULT_PLATFORM, "slack");
  // "live" means a transport EXISTS in the tree, not that it is connected — whether credentials are
  // saved and a connection is up is runtime state (src/platforms/live.js), and an unconnected
  // platform still hands out a connector that throws on write.
  assert.deepEqual(livePlatformIds(), ["slack", "googlechat", "msteams"]);
  assert.equal(platformStatus("slack"), "ga");
  // Preview until each has run against a real tenant; the descriptor is what says so.
  assert.equal(platformStatus("googlechat"), "beta");
  assert.equal(platformStatus("msteams"), "beta");
});

test("the platform UI manifest contains cloneable data and no runtime functions", () => {
  const manifests = platformUiManifest();
  assert.deepEqual(manifests.map(({ id }) => id), PLATFORM_IDS);
  assert.doesNotThrow(() => structuredClone(manifests));
  assert.doesNotThrow(() => JSON.stringify(manifests));
  for (const manifest of manifests) {
    assert.equal(manifest.normalizeName, undefined);
    assert.equal(manifest.formatOutbound, undefined);
    assert.equal(manifest.createConnector, undefined);
    assert.equal(manifest.health, undefined);
    assert.equal(manifest.supportsThreads, undefined);
  }
});

test("registry manifests omit optional runtime helpers without maintaining a method-name list", () => {
  const registry = createPlatformRegistry([{ ...base(), futureRuntimeHook: () => "runtime only" }]);
  assert.equal(registry.manifests()[0].futureRuntimeHook, undefined);
  assert.equal(registry.require("probe").futureRuntimeHook(), "runtime only");
});

test("an unknown or missing platform resolves to Slack, not to the least-capable descriptor", () => {
  // Every channel row written before multi-platform support has no platform value. Falling through
  // to "least capable" would silently degrade a live Slack channel's replies.
  assert.equal(platformOr("").id, "slack");
  assert.equal(platformOr(undefined).id, "slack");
  assert.equal(platformOr("hipchat").id, "slack");
  assert.equal(isPlatformId("hipchat"), false);
  assert.equal(normalizePlatformId("MSTeams"), "msteams");
  assert.equal(normalizePlatformId("hipchat"), "");
});

test("platformSupports throws on an unknown capability key rather than answering no", () => {
  assert.equal(platformSupports("slack", "nativeStreaming"), true);
  assert.equal(platformSupports("msteams", "nativeStreaming"), false);
  assert.throws(() => platformSupports("slack", "nativeStreamingg"), /Unknown platform capability/);
});

test("the descriptors encode the documented platform limits", () => {
  assert.equal(capabilitiesFor("googlechat").modals, false); // Pub/Sub mode has no dialogs
  assert.equal(capabilitiesFor("googlechat").buttons, true); // card clicks DO arrive on the topic
  assert.equal(capabilitiesFor("googlechat").editsPerSecond, 1); // 1 write/sec per space
  assert.equal(capabilitiesFor("msteams").ephemeral, false);
  assert.equal(capabilitiesFor("msteams").markdownLists, false); // desktop-only rendering
  for (const id of ["googlechat", "msteams"]) {
    for (const cap of ["nativeTables", "nativeCharts", "lists", "canvases"]) {
      assert.equal(capabilitiesFor(id)[cap], false, `${id}.${cap}`);
    }
  }
});

// ── id namespacing ────────────────────────────────────────────────────────────

test("conversation ids are namespaced per platform, and Slack's stay bare", () => {
  assert.equal(qualifyConversationId("slack", "C123"), "C123");
  assert.equal(qualifyConversationId("googlechat", "spaces/AAA"), "gchat:spaces/AAA");
  assert.equal(qualifyConversationId("msteams", "19:abc@thread.tacv2"), "teams:19:abc@thread.tacv2");
  // Idempotent — re-qualifying an already-qualified id must not double the prefix.
  assert.equal(qualifyConversationId("googlechat", "gchat:spaces/AAA"), "gchat:spaces/AAA");
  assert.deepEqual(parseConversationId("gchat:spaces/AAA"), { platform: "googlechat", id: "spaces/AAA" });
  assert.deepEqual(parseConversationId("teams:19:abc"), { platform: "msteams", id: "19:abc" });
  // An unprefixed id is a pre-existing Slack row.
  assert.deepEqual(parseConversationId("C123"), { platform: "slack", id: "C123" });
});

// ── degradation ───────────────────────────────────────────────────────────────

test("a pipe table degrades to a fixed-width block that keeps every cell", () => {
  const md = "| Env | Cost |\n|---|---|\n| prod | 12 |\n| staging | 3 |";
  const out = tablesToFixedWidth(md);
  assert.match(out, /^```$/m);
  for (const cell of ["Env", "Cost", "prod", "12", "staging", "3"]) assert.match(out, new RegExp(cell));
});

test("degradation never rewrites fenced code", () => {
  const md = "```js\n| not | a | table |\n# not a heading\n![x](y)\n- not a bullet\n```";
  assert.equal(degradeMarkdown(md, {}), md);
  assert.equal(splitFences(md).length, 1);
  assert.equal(splitFences(md)[0].code, true);
});

test("an unterminated fence stays code rather than being re-flowed", () => {
  const md = "text\n```\n| a | b |\n|---|---|";
  const segments = splitFences(md);
  assert.equal(segments.at(-1).code, true);
});

test("degradeMarkdown applies exactly the transforms the capabilities call for", () => {
  const md = "## Title\n\n- one\n\n> quoted\n\n![alt](https://x.test/i.png)";
  const permissive = degradeMarkdown(md, { markdownTables: true, markdownHeadings: true, markdownImages: true, markdownLists: true, blockQuotes: true });
  assert.equal(permissive, md);
  const strict = degradeMarkdown(md, {});
  assert.match(strict, /\*\*Title\*\*/);
  assert.match(strict, /• one/);
  assert.match(strict, /^quoted$/m);
  assert.match(strict, /\[alt\]\(https:\/\/x\.test\/i\.png\)/);
  assert.doesNotMatch(strict, /!\[/);
});

test("chunkText splits on line boundaries and never leaves a fence open", () => {
  const body = ["```", ...Array.from({ length: 40 }, (_, i) => `line ${i} ${"x".repeat(30)}`), "```"].join("\n");
  const chunks = chunkText(body, 400);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    const fences = (chunk.match(/^```/gm) || []).length;
    assert.equal(fences % 2, 0, `unbalanced fence in chunk:\n${chunk}`);
  }
  assert.deepEqual(chunkText("short", 400), ["short"]);
  assert.deepEqual(chunkText("", 400), []);
});

// ── outbound formatters ───────────────────────────────────────────────────────

const DIR = { map: new Map([["alex doe", "U04"], ["sam", "U05"]]), maxWords: 2 };
const normalizeName = (s) => String(s).trim().toLowerCase();

test("Google Chat resolves a sanctioned @Name and defangs a model-authored one", () => {
  const out = formatChatOutbound(
    "Ping @Alex Doe, also <users/all> and <users/123>.",
    { capabilities: capabilitiesFor("googlechat"), directory: DIR, normalizeName },
  );
  assert.match(out.text, /<users\/U04>/);
  // The model's own sequences must not survive as live annotations.
  assert.doesNotMatch(out.text, /<users\/all>/);
  assert.doesNotMatch(out.text, /<users\/123>/);
  assert.equal(out.chunks.every((c) => c.mentions.length === 0), true);
});

test("Teams emits the <at> tag AND the matching entity, and escapes a model-authored tag", () => {
  const out = formatTeamsOutbound(
    "Hi @Sam, see <at>Boss</at>.",
    { capabilities: capabilitiesFor("msteams"), directory: DIR, normalizeName },
  );
  assert.match(out.text, /<at>Sam<\/at>/);
  assert.match(out.text, /&lt;at>Boss&lt;\/at>/);
  const mentions = out.chunks.flatMap((c) => c.mentions);
  assert.deepEqual(mentions, [{ type: "mention", text: "<at>Sam</at>", mentioned: { id: "U05", name: "Sam" } }]);
});

test("Teams entities are filtered per chunk so a split answer never ships an orphan entity", () => {
  const filler = Array.from({ length: 60 }, (_, i) => `line ${i} ${"y".repeat(40)}`).join("\n");
  const out = formatTeamsOutbound(
    `Hi @Sam.\n${filler}\nBye @Alex Doe.`,
    { capabilities: { ...capabilitiesFor("msteams"), maxMessageChars: 500 }, directory: DIR, normalizeName },
  );
  assert.ok(out.chunks.length > 1);
  for (const chunk of out.chunks) {
    for (const mention of chunk.mentions) assert.ok(chunk.text.includes(mention.text));
  }
  assert.ok(out.chunks.some((c) => c.mentions.length === 0), "a middle chunk should carry no entities");
});

test("every platform formatter emits uniform { text, chunks:[{text,mentions}] }", () => {
  for (const id of PLATFORM_IDS) {
    const out = formatOutboundFor(id, "**hi** @Sam", { directory: DIR });
    assert.equal(typeof out.text, "string");
    assert.ok(Array.isArray(out.chunks));
    for (const chunk of out.chunks) {
      assert.equal(typeof chunk.text, "string");
      assert.ok(Array.isArray(chunk.mentions));
    }
  }
});

test("no platform formatter lets a model-authored broadcast through live", () => {
  const hostile = "<!channel> <!here> <@U999> <users/all> <at>Everyone</at>";
  for (const id of PLATFORM_IDS) {
    const { text } = formatOutboundFor(id, hostile, { directory: DIR });
    const live = capabilitiesFor(id).mentionSyntax;
    if (live === "slack") assert.doesNotMatch(text, /<!channel>|<@U999>/);
    if (live === "gchat") assert.doesNotMatch(text, /<users\/all>/);
    if (live === "teams") assert.doesNotMatch(text, /<at>Everyone<\/at>/);
  }
});

// ── connector ─────────────────────────────────────────────────────────────────

test("a not-yet-wired platform's connector throws on write instead of silently dropping it", async () => {
  const connector = platformOr("googlechat").createConnector();
  assert.equal(connector.ready(), false);
  await assert.rejects(() => connector.post({ conversationId: "x", text: "hi" }), /cannot post/);
  await assert.rejects(() => connector.openDm("u"), /cannot open a DM/);
  // Reads answer honestly rather than throwing — a directory lookup is allowed to come back empty.
  assert.equal((await connector.directory()).map.size, 0);
  assert.equal(connector.threadFor("123.456"), null);
});

test("postFormatted puts the footer on the last chunk only and never posts nothing", async () => {
  const posted = [];
  const connector = createNullConnector("probe", capabilitiesFor("slack"));
  connector.post = async (payload) => { posted.push(payload); return { messageId: String(posted.length) }; };
  await postFormatted(connector, {
    conversationId: "C1", threadKey: "1.1", footer: "stats",
    formatted: { chunks: [{ text: "a", mentions: [] }, { text: "b", mentions: [] }] },
  });
  assert.equal(posted.length, 2);
  assert.equal(posted[0].footer, undefined);
  assert.equal(posted[1].footer, "stats");

  posted.length = 0;
  await postFormatted(connector, { conversationId: "C1", formatted: { chunks: [] } });
  assert.equal(posted.length, 1);
  assert.match(posted[0].text, /no output/);
});

// ── notify bridge ─────────────────────────────────────────────────────────────

function fakeSlackClient() {
  const calls = [];
  return {
    calls,
    chat: {
      postMessage: async (payload) => { calls.push(["post", payload]); return { ts: "111.222", channel: payload.channel }; },
      update: async (payload) => { calls.push(["update", payload]); return {}; },
      delete: async (payload) => { calls.push(["delete", payload]); return {}; },
    },
    conversations: { open: async ({ users }) => { calls.push(["open", users]); return { channel: { id: `D-${users}` } }; } },
  };
}

test("postNotice wraps a raw Slack client once and posts through the connector", async () => {
  const client = fakeSlackClient();
  const res = await postNotice(client, { conversationId: "C1", threadKey: "1.1", text: "hi" });
  assert.deepEqual(client.calls[0], ["post", { channel: "C1", text: "hi", thread_ts: "1.1" }]);
  assert.equal(res.messageId, "111.222");
  // The same client must not spawn a new connector on every notice.
  assert.equal(asConnector(client), asConnector(client));
});

test("a synthetic session key is never sent as a thread id", async () => {
  const client = fakeSlackClient();
  await postNotice(client, { conversationId: "C1", threadKey: "sched-42-1699", text: "hi" });
  assert.equal("thread_ts" in client.calls[0][1], false);
  // A derived key keeps its real thread root.
  await postNotice(client, { conversationId: "C1", threadKey: "111.222::agent-7", text: "hi" });
  assert.equal(client.calls[1][1].thread_ts, "111.222");
});

test("Block Kit blocks ride only on a Block Kit platform; elsewhere the text still delivers", async () => {
  const client = fakeSlackClient();
  const blocks = [{ type: "section", text: { type: "mrkdwn", text: "x" } }];
  await postNotice(client, { conversationId: "C1", text: "hi", blocks });
  assert.deepEqual(client.calls[0][1].blocks, blocks);

  const posted = [];
  const chatConnector = createNullConnector("googlechat", capabilitiesFor("googlechat"));
  chatConnector.post = async (payload) => { posted.push(payload); return { messageId: "1" }; };
  await postNotice(chatConnector, { conversationId: "spaces/A", text: "hi", blocks });
  assert.equal(posted[0].blocks, undefined);
  assert.equal(posted[0].text, "hi");
});

test("postDirectMessage opens the 1:1 through the connector", async () => {
  const client = fakeSlackClient();
  const res = await postDirectMessage(client, { userId: "U04", text: "digest" });
  assert.deepEqual(client.calls[0], ["open", "U04"]);
  assert.equal(res.conversationId, "D-U04");
  assert.equal(res.messageId, "111.222");
});

test("postNotice with no transport connected is a no-op, not a crash", async () => {
  assert.equal(await postNotice(null, { conversationId: "C1", text: "hi" }), null);
  assert.equal(await postDirectMessage(undefined, { userId: "U1", text: "hi" }), null);
});

// ── platform-aware gateway-usage guide ────────────────────────────────────────

test("the guide resolves per platform: overlay wins, other platforms are invisible, drops apply", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-guide-"));
  const prevRoot = process.env.CHANNELGATE_DIR;
  process.env.CHANNELGATE_DIR = root;
  try {
    const { resolvedGuideFiles, applyGatewayGuide, validGuideFile, guideTargetPath } = await import("../src/gateway/guide.js");

    assert.equal(validGuideFile("platforms/msteams/writing-replies.md"), "platforms/msteams/writing-replies.md");
    assert.equal(validGuideFile("platforms/hipchat/x.md"), "");
    assert.equal(validGuideFile("platforms/../../etc/passwd.md"), "");
    assert.equal(guideTargetPath("platforms/msteams/writing-replies.md"), "references/writing-replies.md");
    assert.equal(guideTargetPath("platforms/msteams/SKILL.md"), "SKILL.md");

    const teams = await resolvedGuideFiles("msteams");
    const slack = await resolvedGuideFiles("slack");
    // Both surfaces get a writing-replies + platform reference, from their OWN platform dir.
    for (const set of [teams, slack]) {
      assert.ok(set.has("references/writing-replies.md"));
      assert.ok(set.has("references/platform.md"));
    }
    assert.notEqual(teams.get("references/writing-replies.md").src, slack.get("references/writing-replies.md").src);
    assert.match(teams.get("references/platform.md").src, /platforms\/msteams\//);
    // No target path may ever come from another platform's directory.
    for (const [, entry] of teams) assert.doesNotMatch(entry.src, /platforms\/(slack|googlechat)\//);
    // guideDrop removes capabilities this surface does not have.
    assert.ok(slack.has("references/tables.md"));
    assert.equal(teams.has("references/tables.md"), false);
    assert.equal(teams.has("references/charts.md"), false);

    // Materialize and check the placeholder substitution actually happened.
    const cwd = path.join(root, "channel");
    await mkdir(cwd, { recursive: true });
    await applyGatewayGuide(cwd, { platform: "msteams" });
    const skill = await readFile(path.join(cwd, ".claude", "skills", "gateway-usage", "SKILL.md"), "utf8");
    assert.match(skill, /Operating inside Microsoft Teams/);
    assert.doesNotMatch(skill, /\{\{PLATFORM\}\}/);
    const replies = await readFile(path.join(cwd, ".claude", "skills", "gateway-usage", "references", "writing-replies.md"), "utf8");
    assert.match(replies, /Writing Microsoft Teams replies/);
    await assert.rejects(
      () => readFile(path.join(cwd, ".claude", "skills", "gateway-usage", "references", "tables.md"), "utf8"),
      /ENOENT/,
    );

    // Re-materializing for a different platform must replace, not merge, the previous surface's files.
    await applyGatewayGuide(cwd, { platform: "slack" });
    const slackReplies = await readFile(path.join(cwd, ".claude", "skills", "gateway-usage", "references", "writing-replies.md"), "utf8");
    assert.match(slackReplies, /Writing Slack replies/);
    assert.match(await readFile(path.join(cwd, ".claude", "skills", "gateway-usage", "references", "tables.md"), "utf8"), /\w/);
  } finally {
    if (prevRoot === undefined) delete process.env.CHANNELGATE_DIR;
    else process.env.CHANNELGATE_DIR = prevRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("an admin override still wins over the platform file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-guide-ovr-"));
  const prevRoot = process.env.CHANNELGATE_DIR;
  process.env.CHANNELGATE_DIR = root;
  try {
    const { resolvedGuideFiles, updateGatewayGuide, resetGatewayGuide } = await import("../src/gateway/guide.js");
    await updateGatewayGuide({ file: "platforms/msteams/writing-replies.md", content: "# custom teams replies\n" });
    const teams = await resolvedGuideFiles("msteams");
    assert.equal(teams.get("references/writing-replies.md").overridden, true);
    assert.match(await readFile(teams.get("references/writing-replies.md").src, "utf8"), /custom teams replies/);
    // …and only for that platform.
    assert.equal((await resolvedGuideFiles("slack")).get("references/writing-replies.md").overridden, false);
    await resetGatewayGuide({ file: "platforms/msteams/writing-replies.md" });
    assert.equal((await resolvedGuideFiles("msteams")).get("references/writing-replies.md").overridden, false);
  } finally {
    if (prevRoot === undefined) delete process.env.CHANNELGATE_DIR;
    else process.env.CHANNELGATE_DIR = prevRoot;
    await rm(root, { recursive: true, force: true });
  }
});
