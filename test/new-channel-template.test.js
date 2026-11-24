import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { saveConversationTemplate } from "../public/admin-conversation-templates.js";

const app = readFileSync(new URL("../src/slack/app.js", import.meta.url), "utf8");
const pipeline = readFileSync(new URL("../src/slack/message-pipeline.js", import.meta.url), "utf8");
const ingest = readFileSync(new URL("../src/platforms/ingest.js", import.meta.url), "utf8");

const ui = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("first channel registration copies the configured channel template", () => {
  assert.match(app, /handleBotJoinedChannel\(event/);
  assert.match(app, /applyChannelTemplate\(defaultChannelMeta/);
  assert.match(pipeline, /applyChannelTemplate\(defaultChannelMeta/);
  assert.match(ingest, /applyChannelTemplate\(defaultChannelMeta/);
});

test("conversation templates are reached from Conversations", () => {
  assert.match(html, /data-seg="templates">Templates/);
  assert.doesNotMatch(html, /id="set-templates"|id="skill-templates-editor"/);
  assert.doesNotMatch(ui, /renderSkillTemplatesSettings|dmTplEditors|channelTplEditor/);
});

test("template saves send only the chosen role and keep unrepresented stored fields", async () => {
  for (const id of ["channel", "user", "admin"]) {
    const requests = [];
    const stored = { skills: ["unavailable"], model: "saved", allowNetwork: false };
    const baseline = { skills: [], model: "", allowNetwork: false };
    const values = { ...baseline, allowNetwork: true };
    const patch = { ...stored, allowNetwork: true };
    const result = await saveConversationTemplate({
      api: async (path, options) => {
        assert.equal(path, "/api/settings");
        assert.equal(options.method, "PUT");
        requests.push(JSON.parse(options.body));
        return { settingsVersion: "v2" };
      }, id, stored, version: "v1", baseline, values,
    });
    assert.deepEqual(requests, [{ ...(id === "channel" ? { channelTemplate: patch } : { dmTemplates: { [id]: patch } }), settingsVersion: "v1", connectSlack: false }]);
    assert.deepEqual(result, { previousVersion: "v1", settings: { settingsVersion: "v2" } });
  }
});

test("a concurrent edit to another template is preserved; editing the same template refuses the save", async () => {
  for (const changedSame of [false, true]) {
    const stored = { model: "original" };
    const latest = { settingsVersion: "v2", dmTemplates: { user: changedSame ? { model: "by-another-admin" } : stored, admin: { cleanMode: true } } };
    const versions = [];
    const save = saveConversationTemplate({
      api: async (_path, options) => {
        const body = JSON.parse(options.body);
        versions.push(body.settingsVersion);
        assert.deepEqual(body.dmTemplates, { user: { model: "new" } });
        if (versions.length === 1) throw Object.assign(new Error("stale"), { status: 409, body: latest });
        return { settingsVersion: "v3" };
      }, id: "user", stored, version: "v1", baseline: stored, values: { model: "new" },
    });
    if (changedSame) {
      await assert.rejects(save, /template changed elsewhere/);
      assert.deepEqual(versions, ["v1"]);
    } else {
      assert.deepEqual(await save, { previousVersion: "v2", settings: { settingsVersion: "v3" } });
      assert.deepEqual(versions, ["v1", "v2"]);
    }
  }
});
