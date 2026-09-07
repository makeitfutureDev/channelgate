import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureTestEnv, tempDir } from "./helpers.js";

ensureTestEnv();
const { resolveRuntime } = await import("../src/runtimes/resolve.js");
const { ensureChannelFolder } = await import("../src/gateway/folders.js");
const { applyGatewayGuide, updateGatewayGuide, resetGatewayGuide } = await import("../src/gateway/guide.js");
const readGuide = (cwd, rel = "SKILL.md") => readFile(path.join(cwd, ".claude/skills/gateway-usage", rel), "utf8");

// Real resolver/mount policy -> generated instructions, without starting containers or engines.
test("the guide states the resolved home grant for every platform and refreshes both switches", async () => {
  const cwd = tempDir("cg-home-guide-");
  try {
    for (const platform of ["slack", "msteams", "googlechat"]) {
      for (const [adminMode, fullAccessHome] of [[false, false], [false, true], [true, true], [true, false]]) {
        const target = resolveRuntime("guide-grant", { platform, adminMode }, { settings: { fullAccessHome } });
        await applyGatewayGuide(cwd, { platform, target });
        const skill = await readGuide(cwd);
        assert.match(skill, new RegExp("containerFullAccessHome` is \\*\\*" + (fullAccessHome ? "on" : "off") + "\\*\\*"));
        if (adminMode && fullAccessHome) {
          assert.ok(skill.includes(JSON.stringify(os.homedir())));
          assert.match(skill, /resolved runtime includes the operator-home mount/);
          assert.match(skill, /Every admitted author can read/);
          assert.match(skill, /bypass tools still require an admin author in Admin mode/);
          assert.doesNotMatch(skill, /has no operator-home mount/);
        } else {
          assert.match(skill, /resolved runtime has no operator-home mount/);
          assert.doesNotMatch(skill, /resolved runtime includes the operator-home mount/);
        }
        assert.match(skill, /\$HOME.*~.*channel's own home volume/);
        assert.doesNotMatch(skill, /\{\{CONTAINER_ACCESS\}\}|host paths do not exist in here, for anyone|nothing of the host/);
        const admin = await readGuide(cwd, "references/administration.md");
        assert.match(admin, /containerFullAccessHome.*off by default/);
        assert.match(admin, /ONLY when this channel is in Admin\/Full-access mode/);
        assert.match(admin, /no MCP tool can flip it/);
        assert.match(admin, /storage is masked/);
        assert.match(admin, /configuration, logs, metadata and credential/);
        assert.doesNotMatch(admin, /whatever the mode|sees one host directory|they \*\*do not exist\*\*/);
      }
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("folder provisioning carries the resolved grant into ordinary and clean engine discovery", async () => {
  for (const cleanMode of [false, true]) {
    const slug = "provision-home-guide-" + cleanMode;
    const meta = { platform: "slack", adminMode: true, cleanMode, allowedMcps: [], skills: [] };
    const target = resolveRuntime(slug, meta, { settings: { fullAccessHome: true } });
    const { cwd } = await ensureChannelFolder(slug, meta, { target });
    const claude = await readGuide(cwd);
    const codex = await readFile(path.join(cwd, ".agents/skills/gateway-usage/SKILL.md"), "utf8");
    assert.equal(codex, claude);
    assert.match(claude, /resolved runtime includes the operator-home mount/);
    assert.match(claude, /containerFullAccessHome` is \*\*on\*\*/);
  }
});

test("missing runtime facts remain unknown and admin overrides retain their documented precedence", async () => {
  const cwd = tempDir("cg-home-override-");
  try {
    await applyGatewayGuide(cwd);
    assert.match(await readGuide(cwd), /no resolved runtime target was supplied/);
    assert.doesNotMatch(await readGuide(cwd), /containerFullAccessHome` is \*\*off/);
    await updateGatewayGuide({ file: "SKILL.md", content: "# Operator customization\n\n{{CONTAINER_ACCESS}}\n" });
    const target = resolveRuntime("override-home", { adminMode: true }, { settings: { fullAccessHome: true } });
    await applyGatewayGuide(cwd, { target });
    assert.match(await readGuide(cwd), /^# Operator customization/);
    assert.match(await readGuide(cwd), /resolved runtime includes the operator-home mount/);
    await resetGatewayGuide({ file: "SKILL.md" });
    await applyGatewayGuide(cwd, { target });
    assert.match(await readGuide(cwd), /name: gateway-usage/);
    assert.match(await readGuide(cwd), /resolved runtime includes the operator-home mount/);
  } finally {
    await resetGatewayGuide({ file: "SKILL.md" });
    await rm(cwd, { recursive: true, force: true });
  }
});
