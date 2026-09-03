#!/usr/bin/env node
// Fresh-install choice for the optional local Whisper runtime/model. The decision is persisted in
// the gateway's normal settings store; the existing idempotent provisioner remains the one owner
// of downloads/builds and is also available through `npm run whisper:install`.
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { stdin, stdout } from "node:process";
import { getWhisperEnabled, saveSettings } from "../src/config/settings.js";
import { provisionWhisper } from "./install-whisper.mjs";

const TRUE_VALUES = new Set(["1", "true", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "n", "off"]);

function parseBooleanWord(value, label) {
  const word = String(value ?? "").trim().toLowerCase();
  if (TRUE_VALUES.has(word)) return true;
  if (FALSE_VALUES.has(word)) return false;
  throw new Error(`${label} must be one of yes/no, true/false, 1/0, or on/off.`);
}

export function parseWhisperChoice({ args = [], env = {} } = {}) {
  const withWhisper = args.includes("--with-whisper");
  const withoutWhisper = args.includes("--without-whisper");
  if (withWhisper && withoutWhisper) throw new Error("Cannot use both --with-whisper and --without-whisper.");
  if (withWhisper) return true;
  if (withoutWhisper) return false;
  if (env.CG_INSTALL_WHISPER !== undefined && env.CG_INSTALL_WHISPER !== "") {
    return parseBooleanWord(env.CG_INSTALL_WHISPER, "CG_INSTALL_WHISPER");
  }
  return null;
}

export function parsePromptAnswer(answer, defaultEnabled = true) {
  const word = String(answer ?? "").trim();
  if (!word) return Boolean(defaultEnabled);
  try {
    return parseBooleanWord(word, "Answer");
  } catch {
    return null;
  }
}

export async function runWhisperSetup({
  args = [],
  env = {},
  interactive = false,
  currentEnabled = true,
  question,
  save = saveSettings,
  provision = provisionWhisper,
  write = (line) => stdout.write(`${line}\n`),
} = {}) {
  let enabled = parseWhisperChoice({ args, env });
  if (enabled === null && interactive) {
    if (typeof question !== "function") throw new Error("Interactive Whisper setup requires a question function.");
    while (enabled === null) {
      const suffix = currentEnabled ? "Y/n" : "y/N";
      enabled = parsePromptAnswer(await question(`Install local Whisper for voice notes? [${suffix}] `), currentEnabled);
      if (enabled === null) write("Please answer yes or no.");
    }
  }
  if (enabled === null) enabled = Boolean(currentEnabled);

  save({ whisperEnabled: enabled });
  if (!enabled) {
    write("→ Local Whisper disabled — skipping runtime and model installation.");
    return false;
  }

  write("→ Installing local Whisper + multilingual model…");
  await provision();
  return true;
}

async function main() {
  const interactive = Boolean(stdin.isTTY && stdout.isTTY);
  const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;
  try {
    await runWhisperSetup({
      args: process.argv.slice(2),
      env: process.env,
      interactive,
      currentEnabled: getWhisperEnabled(),
      question: rl ? (prompt) => rl.question(prompt) : undefined,
    });
  } finally {
    rl?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`❌ Whisper setup failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
