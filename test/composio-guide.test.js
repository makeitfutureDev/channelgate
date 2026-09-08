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
  // A logical identity says how to route, not who owns an external account or whether channels
  // share it. Clarifying those facts must never weaken selected-identity routing.
  assert.match(skill, /not proof of the connected service owner's name or cross-channel sharing/is);
  assert.match(skill, /may reach the same service owner or different owners/is);
  assert.match(skill, /Matching owners never authorize substituting identities/is);
  assert.match(skill, /not universally shared across channels/is);
  assert.match(skill, /unless verified/is);
  const admin = await read("references/administration.md");
  assert.match(admin, /Routine replies need no credential details/is);
  assert.match(admin, /without assuming the current source or connected service owner/is);
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
  // Discovery checks the selected identity and remains read-only: the search tool is the ONLY
  // side-effect-free existence check, and `has_active_connection` is what makes a toolkit present.
  assert.match(skill, /`COMPOSIO_SEARCH_TOOLS` is the ONLY side-effect-free way/i);
  assert.match(skill, /COMPOSIO_SEARCH_TOOLS.*`toolkit_connection_statuses/is);
  assert.match(skill, /`has_active_connection` is true/i);
  assert.match(skill, /`accounts\[\]`.*account aliases/is);
  // MANAGE_CONNECTIONS list is NOT an inventory route — on an unconnected toolkit it initiates.
  assert.match(skill, /Never call `COMPOSIO_MANAGE_CONNECTIONS` with `action: "list"` during discovery or inventory/i);
  assert.match(skill, /NOT read-only.*CREATES a\s+pending authorization request/is);
  assert.match(skill, /status: "initiated"/);
  assert.match(skill, /only for a toolkit the\s+search tool has already shown as connected/is);
  assert.match(skill, /inventory request is never permission to initiate connections/is);
  assert.match(skill, /never substitute.*silently fall back/is);
  // DMs: no agent account at all.
  assert.match(skill, /In a DM you have no account of your own/i);
});

test("the operating guide makes dual Gmail identity selection explicit", async () => {
  const skill = await read("SKILL.md");

  assert.match(skill, /“my[^”]*”.*requester's Gmail/is);
  assert.match(skill, /“your[^”]*”.*your\* Gmail/is);
  assert.match(skill, /BOTH have the app.*MUST ask which account.*no tool call/is);
});

test("the ambiguous identity case is a MUST-ask hard stop with a stated privacy reason", async () => {
  const skill = await read("SKILL.md");

  assert.match(skill, /Ambiguity is a hard stop, not a preference/i);
  // The first response is the question, never a tool call — not even a read-only peek.
  assert.match(skill, /first response MUST be the question.*MUST NOT be\s+a tool call/is);
  assert.match(skill, /no read-only peek/i);
  // The one-line rationale: private data of the requester or a third party.
  assert.match(skill, /exposes the requester's own private data, or a\s+third party's/is);
  assert.match(skill, /never send, schedule or\s+post from a guessed account/is);
});

test("no guide file still routes connection inventory through COMPOSIO_MANAGE_CONNECTIONS", async () => {
  for (const file of await allGuideFiles()) {
    const text = await readFile(file, "utf8");
    const rel = path.relative(guideDir, file);
    // The retired instruction — "confirm/verify/check ... through MANAGE_CONNECTIONS (list)".
    assert.doesNotMatch(
      text,
      /(confirm|verify|inspect|check)[^.]{0,160}COMPOSIO_MANAGE_CONNECTIONS/is,
      `${rel} still treats MANAGE_CONNECTIONS as an inventory/confirmation step`,
    );
    // Any remaining mention must carry the warning that the call is not side-effect-free.
    for (const match of text.matchAll(/COMPOSIO_MANAGE_CONNECTIONS/g)) {
      const around = text.slice(Math.max(0, match.index - 240), match.index + 240);
      assert.match(
        around,
        /never|do not use|not read-only|initiat/i,
        `${rel} names MANAGE_CONNECTIONS without saying it initiates a connection`,
      );
    }
  }
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
