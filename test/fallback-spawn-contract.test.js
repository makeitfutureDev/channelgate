// A cross-engine failover must hand the FALLBACK harness the same spawn contract the primary would
// have received: its own MCP payload, the channel lockdown, and the approval route.
//
// The incident: the gateway default engine was Codex, Codex ran out of quota, and every channel
// silently moved onto the Claude fallback — where `claude` spawned with no --mcp-config at all.
// The turn answered, so nothing looked broken, but the run had no gateway control server (no
// memory, no schedules, no Slack history, no approval prompt) and no Composio. Users reported it
// as "why is Composio not available?".
//
// The cause was direction-specific: the config FILE path was derived from the PRIMARY engine
// (`usesMcpConfigFile(engine)`), and Codex is argv-transport, so the path was "" and the fallback
// inherited it. Claude→Codex was fine, because Codex rebuilds its servers from the runtime bag.
// The existing failover E2Es all ran clean-mode channels, where an empty MCP payload is CORRECT —
// which is why none of them caught it. These channels are deliberately NOT clean.
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureBin = path.join(projectRoot, "test", "fixtures");
ensureTestEnv();
const { useFakeRuntime: __useFakeRuntime } = await import("./runtime-fake.js");
await __useFakeRuntime();
process.env.PATH = `${fixtureBin}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";

const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage, resetEngineCooldowns } = await import("../src/gateway/run.js");

// The stubs copy the per-run --mcp-config aside before it is swept, named after the run folder, so
// a test can read the payload the CLI was ACTUALLY handed rather than trusting a yes/no flag.
const spawnedMcpServers = async (slug) => {
  const copied = path.join(process.env.TMPDIR || "/tmp", `cg-stub-mcp-${slug}.json`);
  return Object.keys(JSON.parse(await readFile(copied, "utf8")).mcpServers || {});
};

// Not clean: clean mode legitimately injects nothing, and would hide the whole defect.
const connectedDM = async (id, name, engine) => {
  const entry = await upsertChannelEntry(id, { name, type: "im", isDM: true });
  await saveChannelMeta(entry.slug, {
    channelId: id, name: entry.name, type: "im", isDM: true, template: "custom",
    engine, cleanMode: false, allowNetwork: false,
  });
  return entry;
};

test("a Codex→Claude failover spawns Claude with its own MCP config, the lockdown and the approval route", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "codex", engineFallback: true, engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  await setUser("U_FB_CONTRACT", { name: "Fallback Contract", approved: true, isAdmin: false });
  await connectedDM("D_FB_CONTRACT", "fb-contract", "codex");

  const result = await runMessage({
    channelId: "D_FB_CONTRACT",
    authorId: "U_FB_CONTRACT",
    text: "CODEX_STUB_LIMIT_FAIL_SAFE",
    threadKey: "1902.010",
    origin: "slack_foreground",
    preferCold: true,
    getFallbackContext: async () => "Conversation context\n\n",
  });

  assert.equal(result.engine, "claude", "precondition — the turn really failed over");
  assert.equal(result.fallbackFrom, "codex");
  // The stub echoes the argv facts it was spawned with, so these assert the SPAWN, not our intent.
  assert.match(result.content, /mcp=yes/, "the Claude fallback received --mcp-config (the regression)");
  assert.match(result.content, /settings=yes/, "the Claude fallback received the channel lockdown via --settings");
  assert.match(result.content, /permprompt=yes/, "the Claude fallback can still raise an approval card");
  // Not just "a file was passed" — the file the fallback got carries the control server the whole
  // gateway toolset hangs off (memory, schedules, Slack history, the approval prompt).
  assert.ok((await spawnedMcpServers("fb-contract")).includes("gateway"), "the fallback payload carries the gateway control server");
});

test("the reverse direction keeps its gateway MCP too", async () => {
  // Claude→Codex was never broken (Codex builds its servers from the runtime bag, not a file), so
  // this is the guard that a fix aimed at one direction does not cost the other one its tools.
  resetEngineCooldowns();
  saveSettings({ engine: "claude", engineFallback: true, engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  await setUser("U_FB_CONTRACT_REV", { name: "Fallback Contract Reverse", approved: true, isAdmin: false });
  await connectedDM("D_FB_CONTRACT_REV", "fb-contract-rev", "claude");

  const result = await runMessage({
    channelId: "D_FB_CONTRACT_REV",
    authorId: "U_FB_CONTRACT_REV",
    text: "CLAUDE_STUB_LIMIT_FAIL_SAFE",
    threadKey: "1902.020",
    origin: "slack_foreground",
    preferCold: true,
    getFallbackContext: async () => "Conversation context\n\n",
  });

  assert.equal(result.engine, "codex", "precondition — the turn really failed over");
  assert.equal(result.fallbackFrom, "claude");
  assert.match(result.content, /gateway_mcp=yes/, "the Codex fallback still gets the gateway control server");
});

test("a clean-mode failover still injects nothing", async () => {
  // The other half of the contract: the fix must not smuggle an MCP payload into a channel that
  // asked for none. Clean is the reason the original defect hid for so long — keep it honest.
  resetEngineCooldowns();
  saveSettings({ engine: "codex", engineFallback: true, engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  await setUser("U_FB_CLEAN", { name: "Fallback Clean", approved: true, isAdmin: false });
  const entry = await upsertChannelEntry("D_FB_CLEAN", { name: "fb-clean", type: "im", isDM: true });
  await saveChannelMeta(entry.slug, {
    channelId: "D_FB_CLEAN", name: entry.name, type: "im", isDM: true, template: "custom",
    engine: "codex", cleanMode: true, allowNetwork: false,
  });

  const result = await runMessage({
    channelId: "D_FB_CLEAN",
    authorId: "U_FB_CLEAN",
    text: "CODEX_STUB_LIMIT_FAIL_SAFE",
    threadKey: "1902.030",
    origin: "slack_foreground",
    preferCold: true,
    getFallbackContext: async () => "Conversation context\n\n",
  });

  assert.equal(result.engine, "claude", "precondition — the turn really failed over");
  // Clean passes an EXPLICITLY empty payload under --strict-mcp-config (it denies ambient servers
  // rather than leaving them to chance), so the flag is yes and the server list is what matters.
  assert.deepEqual(await spawnedMcpServers("fb-clean"), [], "clean mode still injects no servers");
  assert.match(result.content, /permprompt=no/, "clean mode has no gateway server, so no approval tool to route to");
});

// Live finding (0.5.3 acceptance, Apps in cg-qa-auto): the Codex→Claude failover turn streamed
// Claude's answer under no notice at all. The failover note lived only on the finished `content`,
// and a streamed answer is written from the stream — so the reader never learned Codex was out.
test("a Codex→Claude failover ANNOUNCES its note to the delivery layer, not only on content", async () => {
  resetEngineCooldowns();
  saveSettings({ engine: "codex", engineFallback: true, engineEnabled: { claude: true, codex: true }, composioMode: "personal" });
  await setUser("U_FB_NOTE", { name: "Fallback Note", approved: true, isAdmin: false });
  await connectedDM("D_FB_NOTE", "fb-note", "codex");
  const events = [];
  const result = await runMessage({
    channelId: "D_FB_NOTE",
    authorId: "U_FB_NOTE",
    text: "CODEX_STUB_LIMIT_FAIL_SAFE",
    threadKey: "1902.040",
    origin: "slack_foreground",
    preferCold: true,
    getFallbackContext: async () => "Conversation context\n\n",
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.engine, "claude", "precondition — the turn really failed over");
  const notes = events.filter((e) => e?.kind === "answer_note").map((e) => e.text);
  assert.equal(notes.length, 1, `exactly one note: ${JSON.stringify(notes)}`);
  assert.match(notes[0], /Codex hit its usage limit before any tool call — using Claude/);
  assert.ok(result.content.startsWith(notes[0]), "content carries the same sentence for surfaces with no stream");
  // Announced BEFORE the fallback produced a single word, so it can lead the answer.
  const noteAt = events.findIndex((e) => e?.kind === "answer_note");
  const firstText = events.findIndex((e) => e?.kind === "text" || e?.kind === "delta");
  assert.ok(firstText === -1 || noteAt < firstText, "the note precedes the fallback's own output");
});
