import { test } from "node:test";
import assert from "node:assert/strict";
const { routeDelegation, channelNameFrom } = await import("../src/gateway/voice/delegation-router.ts");
const { buildVoiceTaskText, describeActivity, recentSpokenExchange } = await import("../src/gateway/voice/voice-task.ts");
const { isWhisperPhantom, dropWhisperPhantoms } = await import("../src/gateway/whisper-phantoms.ts");

test("clear gateway actions are routed; everything else, and anything compound, goes to the agent", () => {
  const kind = (text: string) => routeDelegation(text).kind;
  for (const text of ["Goodbye.", "OK, hang up", "end the call please", "That's all for now, thanks"]) assert.equal(kind(text), "end_call", text);
  for (const text of ["Is it done yet?", "What's the status?", "How's it going?", "Any update on it?", "check my tasks"]) assert.equal(kind(text), "check_tasks", text);
  for (const text of ["What did the agent say?", "Read me the thread", "What's in this thread?"]) assert.equal(kind(text), "read_thread", text);
  for (const text of ["Mark this thread as done", "Close this conversation", "mark it done"]) assert.equal(kind(text), "mark_done", text);
  assert.deepEqual(routeDelegation("What am I working on?"), { kind: "list", status: "open", channel: "" });
  assert.deepEqual(routeDelegation("What is pending in the sales channel?"), { kind: "list", status: "waiting", channel: "sales" });
  assert.deepEqual(routeDelegation("Switch to the sales channel"), { kind: "switch", target: "sales channel", index: 0 });
  assert.deepEqual(routeDelegation("Can you take me to the pipeline review?"), { kind: "switch", target: "pipeline review", index: 0 });
  assert.deepEqual(routeDelegation("Open the deploy fix thread"), { kind: "switch", target: "deploy fix", index: 0 });
  assert.deepEqual(routeDelegation("Open the second one"), { kind: "switch", target: "", index: 2 });
  assert.deepEqual(routeDelegation("number 3"), { kind: "switch", target: "", index: 3 });
  assert.deepEqual(routeDelegation("switch to the last one"), { kind: "switch", target: "", index: -1 });
  // Work, and anything that mixes navigation with work, is the agent's.
  for (const text of ["Build the export and run the tests", "Switch to sales and run the weekly report", "Open the file config.json and fix the port",
    "Is the deploy done in production? Check the logs.", "go to the website and download the invoice for last month from the billing page please", "Hello there"]) {
    assert.equal(kind(text), "task", text);
  }
  assert.deepEqual(routeDelegation("  "), { kind: "task", request: "" });
  assert.equal(channelNameFrom("#sales"), "sales");
  assert.equal(channelNameFrom("sales channel"), "sales");
  assert.equal(channelNameFrom("growth team channel"), "growth-team");
  assert.equal(channelNameFrom("pipeline review"), "");
});

test("a voice task carries the request, the voice note and the recent spoken exchange", () => {
  const transcript = [
    { who: "caller", text: "Can you move the meeting" }, { who: "agent", text: "Which day?" }, { who: "caller", text: "Thursday, not Friday." },
  ];
  const text = buildVoiceTaskText({ request: "Thursday, not Friday.", callerName: "Tiberiu", transcript, provider: "chatgpt" });
  assert.match(text, /^Thursday, not Friday\.\n\n\[Voice call note/);
  assert.match(text, /caller's own words as speech recognition heard them/);
  assert.match(text, /ask before acting instead of guessing/);
  assert.match(text, /Recent spoken exchange, oldest first:\nTiberiu: Can you move the meeting\nVoice: Which day\?\nTiberiu: Thursday, not Friday\./);
  assert.match(buildVoiceTaskText({ request: "x", transcript: [], provider: "gemini" }), /voice assistant wrote the request text/);
  assert.doesNotMatch(buildVoiceTaskText({ request: "x", transcript: [] }), /Recent spoken exchange/);
  const long = Array.from({ length: 30 }, (_, i) => ({ who: i % 2 ? "agent" : "caller", text: `line ${i} ${"x".repeat(250)}` }));
  const recent = recentSpokenExchange(long, "T");
  assert.ok(recent.length <= 1_500); assert.match(recent, /line 29/, "the newest lines are kept");
});

test("activity is described for the voice without repeating command lines or URLs", () => {
  assert.equal(describeActivity({ kind: "tool_use", name: "Read", target: "meta.json" }), "reading a file: meta.json");
  assert.equal(describeActivity({ kind: "tool_use", name: "Bash", target: "curl -H 'Authorization: Bearer sk-secret' https://x" }), "running a command");
  assert.equal(describeActivity({ kind: "tool_use", name: "WebFetch", target: "https://x.test/?token=abc" }), "reading a web page");
  assert.equal(describeActivity({ kind: "tool_use", name: "mcp__composio-user__GMAIL_SEND" }), "using composio user");
  assert.equal(describeActivity({ kind: "tool_use", name: "command_execution" }), "running a command");
  assert.equal(describeActivity({ kind: "thinking" }), "thinking");
  assert.equal(describeActivity({ kind: "quiet", silentMs: 1 }), "");
  assert.equal(describeActivity(null), "");
});

test("only whole-transcript Whisper phantoms are dropped", () => {
  for (const text of ["[BLANK_AUDIO]", " Thanks for watching!", "Thank you for watching. Thank you for watching.", "(music)", "♪♪", " you", "Subtitles by the Amara.org community"]) assert.equal(isWhisperPhantom(text), true, text);
  for (const text of ["Okay", "Thanks", "Bye", "Thanks for watching the deploy, now merge it", "Deploy it now"]) assert.equal(isWhisperPhantom(text), false, text);
  assert.equal(dropWhisperPhantoms("[BLANK_AUDIO]"), "");
  assert.equal(dropWhisperPhantoms("Deploy it now"), "Deploy it now");
});
