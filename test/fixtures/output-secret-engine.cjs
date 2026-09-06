#!/usr/bin/env node
// Disposable redaction fixture. The test supplies fake service keys and a fake channel token.
const { writeFileSync } = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const text = args.join(" ");
const engine = path.basename(process.argv[1]);
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
if (args[0] === "features") { process.stdout.write("network_proxy experimental false\n"); process.exit(0); }
if (args[0] === "app-server") {
  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id !== undefined) emit({ id: request.id, result: request.method === "mcpServerStatus/list" ? { data: [] } : {} });
  });
  return;
} else if (!text.includes("OUTPUT_FIXTURE")) { process.exit(0); }
const names = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "OUTPUT_TEST_TOKEN"];
const output = "Visible prefix " + names.map((name) => process.env[name] || "missing").join(" / ") + " visible suffix.";
if (text.includes("OUTPUT_FIXTURE_ERROR")) {
  process.stderr.write("Fixture command failed: " + output + "\n");
  process.exit(1);
}
if (engine === "claude" && text.includes("OUTPUT_FIXTURE_FALLBACK")) {
  emit({ type: "assistant", error: "authentication_failed", message: { role: "assistant", content: [{ type: "text", text: "OAuth session expired and could not be refreshed" }] } });
  process.exit(1);
}
if (engine === "claude") {
  emit({ type: "system", systemMessage: output });
  emit({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "fake-tool", name: "Bash" } } });
  emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "echo " + output }) } } });
  emit({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
  for (let i = 0; i < output.length; i += 3) emit({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: output.slice(i, i + 3) } } });
  emit({ type: "result", subtype: "success", result: output, session_id: "output-fixture-session", usage: { input_tokens: 10, output_tokens: 10 } });
} else {
  emit({ type: "thread.started", thread_id: "output-fixture-codex" });
  emit({ type: "item.completed", item: { id: "message_1", type: "agent_message", text: output } });
  emit({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 10 } });
  const index = args.indexOf("-o");
  if (index >= 0) writeFileSync(args[index + 1], output);
}
