#!/usr/bin/env node
// Provider-free compatibility probe for the pinned real Codex CLI used by the nightly workflow.
// It checks the command surface the adapter depends on without needing credentials or spending.
import { spawnSync } from "node:child_process";
import { processFailureMessage } from "../src/util/process-outcome.js";

function probe(args, expected) {
  const result = spawnSync("codex", args, { encoding: "utf8" });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.error) throw new Error(processFailureMessage("Codex CLI compatibility check", { spawnError: result.error }));
  if (result.status !== 0 || result.signal) {
    throw new Error(processFailureMessage(`Codex CLI compatibility check (${args.join(" ")})`, {
      code: result.status,
      signal: result.signal,
      diagnostic: output,
    }));
  }
  for (const pattern of expected) {
    if (!pattern.test(output)) throw new Error(`codex ${args.join(" ")} no longer exposes ${pattern}: ${output}`);
  }
}

probe(["--version"], [/codex/i]);
probe(["exec", "--help"], [/--json/, /--skip-git-repo-check/, /--output-last-message|\s-o,?/]);
probe(["exec", "resume", "--help"], [/resume/i, /--json/]);
console.log("Pinned Codex CLI command surface is compatible.");
