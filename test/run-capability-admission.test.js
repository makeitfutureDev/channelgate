import path from "node:path";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const scratch = ensureTestEnv();
process.env.PATH = `${path.join(projectRoot, "test", "fixtures")}${path.delimiter}${process.env.PATH || ""}`;
process.env.SESSION_KEEPALIVE = "0";
// Keep the run out of the operator's real ~/Slack Agent, and give this file the whole pool so the
// test itself can decide exactly when the turn is admitted.
process.env.CG_WORKSPACE_DIR = path.join(scratch, "workspace");
process.env.MAX_CONCURRENT_RUNS = "1";
process.env.RESERVED_INTERACTIVE_RUNS = "0";

const { setUser, upsertChannelEntry, saveChannelMeta } = await import("../src/config/store.js");
const { saveSettings } = await import("../src/config/settings.js");
const { runMessage, acquireRunSlot, resetRunSlots } = await import("../src/gateway/run.js");
const { verifyGatewayCapability } = await import("../src/gateway/mcp-capability.js");

// The gateway MCP capability is a signed grant that expires six hours after it is MINTED. It used
// to be minted at the top of runMessage — before the run slot was acquired — while the queue ahead
// of a turn is unbounded: one background agent job holding a slot for a working day meant the turn
// behind it spawned on a claim that had already aged out, and its first gateway tool call failed
// as "expired" on a run that had not started yet. Minting must therefore happen at ADMISSION, next
// to the token file that is already written there.

const capabilityCopyFor = (cwd) => path.join(process.env.TMPDIR || "/tmp", `cg-stub-mcp-${path.basename(cwd)}.json`);

// The stub engine copies the per-run --mcp-config file aside (the real one is deleted the moment
// the run settles); the capability rides in it as the gateway server's env.
function mintedCapability(cwd) {
  const config = JSON.parse(readFileSync(capabilityCopyFor(cwd), "utf8"));
  return config.mcpServers.gateway.env.CG_GATEWAY_CAPABILITY;
}

test("the gateway capability is minted after the run is admitted, not while it queues", async () => {
  saveSettings({ engine: "claude", codexFallback: false, composioMode: "personal" });
  await setUser("U_CAP_ADMISSION", { name: "Cap Admission", approved: true, isAdmin: false });
  const entry = await upsertChannelEntry("D_CAP_ADMISSION", { name: "cap-admission", type: "im", isDM: true });
  await saveChannelMeta(entry.slug, {
    channelId: "D_CAP_ADMISSION",
    name: entry.name,
    type: "im",
    isDM: true,
    template: "custom",
    engine: "claude",
    cleanMode: false, // clean mode injects no gateway MCP server, so there is no capability to mint
    allowNetwork: false,
  });
  rmSync(capabilityCopyFor(entry.slug), { force: true });

  resetRunSlots();
  // Hold the only slot, so the turn below has to queue for it exactly the way it would behind a
  // long-running background job.
  const occupied = await acquireRunSlot({ origin: "slack_foreground" });

  const queued = Promise.withResolvers();
  const running = runMessage({
    channelId: "D_CAP_ADMISSION",
    authorId: "U_CAP_ADMISSION",
    text: "mint after admission",
    threadKey: "1900.200",
    origin: "slack_foreground",
    preferCold: true,
    onEvent: (event) => { if (event?.kind === "run_queued") queued.resolve(); },
  });
  await queued.promise;

  // Wall-clock separation between "joined the queue" and "was admitted". A capability minted the
  // old way carries an iat from before this point.
  await new Promise((resolve) => setTimeout(resolve, 120));
  const admittedAt = Date.now();
  occupied();

  const result = await running;
  assert.match(result.content, /Stub engine reply/, "precondition — the run really spawned an engine");

  const verified = verifyGatewayCapability(mintedCapability(result.cwd), { secret: process.env.CG_APPROVAL_SECRET });
  assert.equal(verified.ok, true, verified.reason || "the capability must verify");
  assert.ok(
    verified.claims.iat >= admittedAt,
    `capability was minted at ${verified.claims.iat}, ${admittedAt - verified.claims.iat}ms before the run was admitted`,
  );
  assert.equal(verified.claims.origin, "slack_foreground", "and it is still the run's own claim");
  assert.equal(verified.claims.engine, "claude");

  rmSync(capabilityCopyFor(result.cwd), { force: true });
  resetRunSlots();
});
