import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/slack/app.js", import.meta.url), "utf8");
const pipeline = readFileSync(new URL("../src/slack/message-pipeline.js", import.meta.url), "utf8");
const ingest = readFileSync(new URL("../src/platforms/ingest.js", import.meta.url), "utf8");
const ui = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("first channel registration copies the configured channel template", () => {
  assert.match(app, /if \(current\) return \{\};/);
  assert.match(app, /applyChannelTemplate\(defaultChannelMeta/);
  assert.match(pipeline, /applyChannelTemplate\(defaultChannelMeta/);
  assert.match(ingest, /applyChannelTemplate\(defaultChannelMeta/);
});

test("Settings exposes and saves a distinct new-channel template editor", () => {
  assert.match(html, /id="tpl-channel-editor"/);
  assert.match(html, /Applied once when a channel is first registered/);
  assert.match(ui, /renderChannelTemplateSettings\(s\.channelTemplate/);
  assert.match(ui, /channelTemplate: channelTplEditor\.getValues\(\)/);
});
