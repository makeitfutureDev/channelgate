import { test } from "node:test";
import assert from "node:assert/strict";

import { HELP_TEXT } from "../src/slack/help.js";

test("/help explains the gateway's essential user workflows", () => {
  const essentials = [
    "`@agent your request`",
    "react 🤖",
    "type `stop`",
    "react 🛑",
    "`@agent /files`",
    "set my Composio token",
    "list skills",
    "`remember that …`",
    "`gateway-usage`",
    "`channel-memory`",
    "remind me in 2 hours",
    "list schedules",
    "run it in the background",
    "voice clip",
    "transcribed locally",
    "large-v3-turbo",
    "Slack transcript",
    "Generate transcript",
    "`/status`",
    "`/pending`",
  ];

  for (const expected of essentials) assert.match(HELP_TEXT, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("/help explains optional local voice transcription and Slack fallback", () => {
  assert.match(HELP_TEXT, /voice clip/i);
  assert.match(HELP_TEXT, /@mention.*🤖/i);
  assert.match(HELP_TEXT, /transcribed locally/i);
  assert.match(HELP_TEXT, /Slack transcript/i);
  assert.match(HELP_TEXT, /Generate transcript/i);
  assert.match(HELP_TEXT, /raw audio.*Claude|Claude.*raw audio/i);
});

test("/help distinguishes thread stops from the top-level /stop command", () => {
  assert.match(HELP_TEXT, /type `stop` in that thread/);
  assert.match(HELP_TEXT, /`\/stop` at top level stops every active run/);
  assert.match(HELP_TEXT, /choose \*Steer Conversation\*, \*Add to Queue\*, or \*Cancel Request\*/i);
  assert.match(HELP_TEXT, /choice card disappears after a valid selection/i);
  assert.match(HELP_TEXT, /`\/next <message>`.*queues directly/i);
});

test("/help describes creating files and broad UTF-8 text editing", () => {
  assert.match(HELP_TEXT, /create new files/i);
  assert.match(HELP_TEXT, /UTF-8 text files.*including `\.env`/i);
  assert.match(HELP_TEXT, /Worker\/Auto/i);
});
