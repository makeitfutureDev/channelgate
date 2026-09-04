#!/usr/bin/env node
// Operator helper: start the requested channel container, keep it leased for the lifetime of the
// VS Code window, refresh the gateway's Claude access-token relay, then release cleanly.
import { listChannels } from "../src/config/store.js";
import { effectiveMeta } from "../src/gateway/run.js";
import { resolveRuntime } from "../src/runtimes/resolve.js";
import { containerRuntimeStatus } from "../src/runtimes/container/index.js";
import { launchVscodeContainer } from "../src/runtimes/container/vscode.js";

const selector = process.argv.slice(2).join(" ").trim();
if (!selector) {
  console.error("Usage: npm run vscode -- <channel id, slug, or exact name>");
  process.exit(2);
}

const channels = await listChannels();
const exact = channels.filter((entry) => [entry.channelId, entry.slug, entry.name].some((value) => String(value || "").toLowerCase() === selector.toLowerCase()));
if (exact.length !== 1) {
  console.error(exact.length ? `More than one channel is named ${JSON.stringify(selector)}; use its id or slug.` : `No registered channel matches ${JSON.stringify(selector)}.`);
  process.exit(2);
}

const entry = exact[0];
const meta = effectiveMeta(entry.meta || {});
const target = resolveRuntime(entry.slug, meta);
const lease = target.runtime.acquireLease(target, { kind: "vscode-start", id: `vscode-${process.pid}` });
try {
  await target.runtime.ensureUp(target, { announce: (message) => console.log(message) });
} finally {
  lease.release();
}
const status = await containerRuntimeStatus(target.settings);
if (!status.cli?.ok) throw new Error(status.cli?.reason || "container CLI unavailable");

console.log(`Opening ${entry.name || entry.slug} in ${target.container.name}. Close the VS Code window to release the container lease.`);
console.log("VS Code requires the Dev Containers extension. For Podman, set dev.containers.dockerPath to podman.");
await launchVscodeContainer(target, { cliBin: status.cli.bin });
