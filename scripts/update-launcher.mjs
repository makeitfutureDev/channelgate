#!/usr/bin/env node
// Runs in an independent systemd user service. Environment values arrive on a private stdin
// pipe instead of becoming visible in ExecStart, systemd unit properties, or temporary files.
// Apply them before importing the updater and its runtime-path modules.
import { pathToFileURL } from "node:url";
import path from "node:path";

export async function launchUpdate({ input = process.stdin, env = process.env, run } = {}) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 4 * 1024 * 1024) throw new Error("update launch environment is too large");
    chunks.push(Buffer.from(chunk));
  }
  const inherited = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!inherited || typeof inherited !== "object" || Array.isArray(inherited)
      || !inherited.CG_UPDATE_OWNER_TOKEN || !inherited.CHANNELGATE_DIR
      || Object.values(inherited).some((value) => typeof value !== "string")) {
    throw new Error("update launch environment is invalid");
  }
  // Replace rather than merge: user-manager defaults must not change this install's identity.
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, inherited);
  const main = run || (await import("./update-runner.mjs")).main;
  return main();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  launchUpdate().catch(() => {
    // A malformed JSON payload may contain credentials. Never print the parsing error/payload.
    console.error("Update service could not load its launch environment or start the runner; check the transaction status.");
    process.exitCode = 1;
  });
}
