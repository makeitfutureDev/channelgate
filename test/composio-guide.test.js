import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const guideDir = fileURLToPath(new URL("../src/gateway/gateway-usage/", import.meta.url));
const read = (rel) => readFile(path.join(guideDir, rel), "utf8");

async function allGuideFiles(dir = guideDir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await allGuideFiles(full)));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

test("gateway operating guide frames the two Composio accounts as YOURS vs the requester's", async () => {
  const skill = await read("SKILL.md");

  assert.match(skill, /`composio-agent`.*YOUR OWN Composio account/is);
  assert.match(skill, /`composio-user`.*requester's personal Composio account/is);
  // The credential's origin is an admin detail the model must not surface.
  assert.match(skill, /channel or organization configuration.*admin detail/is);
  // Pronoun rule, app-agnostic, with the email example the operator asked for.
  assert.match(skill, /“my[^”]*”.*`composio-user`/is);
  assert.match(skill, /“your[^”]*”.*`composio-agent`/is);
  assert.match(skill, /verify my email.*requester's Gmail/is);
  assert.match(skill, /verify your email.*your\* Gmail/is);
  // Tie-breakers: single-connected app is used (and named), both-connected asks.
  assert.match(skill, /only ONE identity has that app connected.*say which/is);
  assert.match(skill, /BOTH have the app.*ask/is);
  // Where to look before promising an action.
  assert.match(skill, /COMPOSIO_SEARCH_TOOLS.*lists the apps connected/is);
  assert.match(skill, /never substitute/i);
  // DMs: no agent account at all.
  assert.match(skill, /In a DM you have no account of your own/i);
});

test("the references defer to SKILL.md and use the self-describing account names", async () => {
  const messages = await read("references/messages.md");
  assert.match(messages, /“my Slack”.*`composio-user`/is);
  assert.match(messages, /“your Slack”.*`composio-agent`/is);
  assert.match(messages, /SKILL\.md/);

  for (const file of await allGuideFiles()) {
    const text = await readFile(file, "utf8");
    const rel = path.relative(guideDir, file);
    // The bare legacy server name is gone; nothing may still teach `mcp__composio__*`.
    assert.doesNotMatch(text, /mcp__composio__/, `${rel} still names the legacy bare namespace`);
    assert.doesNotMatch(text, /`composio`/, `${rel} still names the legacy bare server`);
    // The retired vocabulary that leaked the credential plumbing to users.
    assert.doesNotMatch(text, /channel account|company account|shared channel Composio/i, `${rel} leaks plumbing vocabulary`);
  }
});
