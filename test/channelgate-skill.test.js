import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parseFrontmatter } from "../src/gateway/skills/frontmatter.js";
import { normalizeSkillFiles } from "../src/gateway/skills/files.js";
import { registerMemoryReadTools } from "../src/mcp/tools/channel-admin.js";

const root = path.resolve(".claude/skills/channelgate");

async function skillFiles(dir = root, prefix = "") {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...await skillFiles(path.join(dir, entry.name), relative));
    else if (entry.isFile()) out.push({ path: relative, content: await readFile(path.join(dir, entry.name)) });
  }
  return out;
}

test("the ChannelGate skill is a valid, fully routed package", async () => {
  const files = normalizeSkillFiles(await skillFiles());
  const manifest = files.find((file) => file.path === "SKILL.md").content.toString("utf8");
  const { data, body } = parseFrontmatter(manifest);

  assert.equal(data.name, "channelgate");
  assert.equal(data.metadata.version, "3.0.0");
  assert.match(data.description, /device-login links/);
  assert.match(data.description, /Do not use for ordinary work/);

  const linked = new Set([...body.matchAll(/\]\((references\/[^)#]+\.md)\)/g)].map((match) => match[1]));
  const references = new Set(files.filter((file) => file.path.startsWith("references/")).map((file) => file.path));
  assert.deepEqual([...linked].sort(), [...references].sort(), "every reference must be routed from SKILL.md");

  for (const required of [
    "references/architecture-security.md",
    "references/credentials-connections.md",
    "references/mcp-skills.md",
    "references/channel-memory.md",
    "references/conversation-operations.md",
    "references/folder-headless.md",
  ]) assert.ok(references.has(required), `${required} is missing`);
});

test("the memory retrieval tools retain the gateway text response adapter", async () => {
  const handlers = new Map();
  const server = { registerTool(name, _schema, handler) { handlers.set(name, handler); } };
  const text = (value) => ({ content: [{ type: "text", text: value }] });
  registerMemoryReadTools(server, { slug: "", text });

  assert.deepEqual(
    await handlers.get("search_channel_memory")({ query: "containers" }),
    text("No channel context — can't search memory here."),
  );
  assert.deepEqual(
    await handlers.get("read_channel_memory")({ source: "MEMORY.md" }),
    text("No channel context — can't read memory here."),
  );
});

test("the ChannelGate skill defines deterministic Composio identity discovery", async () => {
  const guide = await readFile(path.join(root, "references/mcp-skills.md"), "utf8");

  assert.match(guide, /`composio-user`.*active requester's personal account/is);
  assert.match(guide, /`composio-agent`.*shared agent account/is);
  assert.match(guide, /both identities have an app such as Gmail.*ambiguous, ask/is);
  assert.match(guide, /Never substitute or silently fall back/is);
  assert.match(guide, /mcp__composio_user__/);
  assert.match(guide, /COMPOSIO_SEARCH_TOOLS.*toolkit_connection_statuses/is);
  assert.match(guide, /COMPOSIO_MANAGE_CONNECTIONS.*action: "list"/is);
  assert.match(guide, /must not initiate connections/is);
});
