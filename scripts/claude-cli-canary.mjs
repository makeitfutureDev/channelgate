#!/usr/bin/env node
// Provider-free compatibility probe for the pinned real Claude Code CLI used by the nightly
// workflow. It validates the command surface the gateway depends on without credentials or spend.
import { spawnSync } from "node:child_process";
import { processFailureMessage } from "../src/util/process-outcome.js";

function probe(args, expected) {
  const result = spawnSync("claude", args, { encoding: "utf8" });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.error) throw new Error(processFailureMessage("Claude CLI compatibility check", { spawnError: result.error }));
  if (result.status !== 0 || result.signal) {
    throw new Error(processFailureMessage(`Claude CLI compatibility check (${args.join(" ")})`, {
      code: result.status,
      signal: result.signal,
      diagnostic: output,
    }));
  }
  for (const pattern of expected) {
    if (!pattern.test(output)) throw new Error(`claude ${args.join(" ")} no longer exposes ${pattern}: ${output}`);
  }
}

probe(["--version"], [/Claude Code/i]);
probe(["--help"], [
  /--print/,
  /--input-format/,
  /--output-format/,
  /--include-partial-messages/,
  /--session-id/,
  /--resume/,
  /--settings/,
  /--setting-sources/,
  /--mcp-config/,
  /--strict-mcp-config/,
  /--plugin-dir/,
  /--dangerously-skip-permissions/,
]);
// Kept as a supported hidden print-mode flag in current releases: validate argument parsing even
// though it is intentionally absent from the public help text.
probe(["--permission-prompt-tool", "mcp__gateway__permission_prompt", "--help"], [/Usage:\s+claude/]);
probe(["--append-system-prompt-file", "/dev/null", "--setting-sources", "", "--help"], [/Usage:\s+claude/]);
console.log("Pinned Claude Code CLI command surface is compatible.");
