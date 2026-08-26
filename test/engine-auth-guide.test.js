import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const skillUrl = new URL("../src/gateway/gateway-usage/SKILL.md", import.meta.url);
const administrationUrl = new URL(
  "../src/gateway/gateway-usage/references/administration.md",
  import.meta.url,
);

test("gateway guide routes engine-auth repair to the host operator without collecting credentials", async () => {
  const [skill, administration] = await Promise.all([
    readFile(skillUrl, "utf8"),
    readFile(administrationUrl, "utf8"),
  ]);

  assert.match(skill, /Claude\/Codex authentication failures.*administration\.md/is);
  assert.match(administration, /computer or VPS running the gateway/is);
  assert.match(administration, /own subscription account or API key/is);
  assert.match(administration, /cannot be repaired\s+remotely by the Slack agent/is);
  assert.match(administration, /Do not ask.*paste.*API key.*OAuth token.*Slack/is);
});
