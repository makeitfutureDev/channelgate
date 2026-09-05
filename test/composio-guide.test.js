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
  assert.match(skill, /named account.*inspect aliases/is);
  // Tie-breakers: single-connected app is used (and named), both-connected asks.
  assert.match(skill, /only ONE identity has that app connected.*say which/is);
  assert.match(skill, /BOTH have the app.*ask/is);
  // Tool registries normalize punctuation; one spelling is not evidence of absence.
  assert.match(skill, /`composio-user` can appear as `composio_user`/is);
  assert.match(skill, /never declare an identity absent.*only one spelling/is);
  // Discovery checks the selected identity and remains read-only.
  assert.match(skill, /COMPOSIO_SEARCH_TOOLS.*`toolkit_connection_statuses`/is);
  assert.match(skill, /COMPOSIO_MANAGE_CONNECTIONS.*action: "list"/is);
  assert.match(skill, /inventory request is not permission to initiate connections/is);
  assert.match(skill, /never substitute.*silently fall back/is);
  // DMs: no agent account at all.
  assert.match(skill, /In a DM you have no account of your own/i);
});

test("the operating guide makes dual Gmail identity selection explicit", async () => {
  const skill = await read("SKILL.md");

  assert.match(skill, /“my[^”]*”.*requester's Gmail/is);
  assert.match(skill, /“your[^”]*”.*your\* Gmail/is);
  assert.match(skill, /BOTH have the app.*ask which account before calling a tool/is);
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
