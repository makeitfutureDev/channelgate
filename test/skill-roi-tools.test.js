// A skill's ROI inputs (minutes one use saves, hourly rate) set through the create_skill /
// update_skill tools and shown by get_skill_info — the same roi_assignments row the ROI board
// edits (src/gateway/roi.js), so a skill created in chat counts on the board from its first use.
import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const catalog = await import("../src/gateway/skills/catalog.js");
const roi = await import("../src/gateway/roi.js");
const { setUser, upsertChannelEntry, saveChannelMeta, defaultChannelMeta } = await import("../src/config/store.js");
const { ctxFromClaims } = await import("../src/mcp/gateway-server.js");
const { register: registerSkillTools } = await import("../src/mcp/tools/skills.js");
const { readEvents } = await import("../src/util/logger.js");

const md = (name, description) => ({ path: "SKILL.md", content: `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDo the thing.\n` });
const say = (r) => r.content[0].text;

async function toolsFor(channelId, authorId) {
  const entry = await upsertChannelEntry(channelId, { name: channelId.toLowerCase(), type: "channel" });
  await saveChannelMeta(entry.slug, { ...defaultChannelMeta({ channelId, name: entry.name, type: "channel", isDM: false }), access: "approved" });
  const tools = new Map();
  registerSkillTools({ registerTool: (name, _def, handler) => tools.set(name, handler) },
    ctxFromClaims({ channelId, slug: entry.slug, authorId, threadKey: "1700000000.000900", principalTrusted: true, engine: "claude", toolset: "full" }));
  return (name, args) => tools.get(name)(args);
}

test("create_skill stores the ROI inputs; update_skill patches them; get_skill_info shows them", async () => {
  await setUser("U_ROI_MEMBER", { name: "Roi Member", approved: true });
  const call = await toolsFor("C_ROI_TOOLS", "U_ROI_MEMBER");

  const created = await call("create_skill", { files: [md("Roi Invoices", "Reconcile invoices")], roi_minutes_saved: 20, roi_hourly_rate: 45 });
  assert.match(say(created), /Created channel skill `roi-invoices`/);
  assert.match(say(created), /ROI: saves 20 min per use at \$45\/h/);
  assert.deepEqual([roi.getSkillRoi("roi-invoices").minutes, roi.getSkillRoi("roi-invoices").rate], [20, 45]);
  assert.ok(roi.roiAssignments("skill").has("\nroi-invoices"), "the ROI board reads the same row");

  // Only the rate changes: the minutes are kept, no new revision is written.
  const before = catalog.getSkill("roi-invoices").currentRevisionId;
  const patched = await call("update_skill", { skill: "roi-invoices", roi_hourly_rate: 60 });
  assert.match(say(patched), /ROI inputs saved[\s\S]*saves 20 min per use at \$60\/h/);
  assert.equal(catalog.getSkill("roi-invoices").currentRevisionId, before);
  assert.match(say(await call("get_skill_info", { skill: "roi-invoices" })), /ROI: saves 20 min per use at \$60\/h/);
  assert.ok((await readEvents({ limit: 50 })).some((e) => e.event === "skill_roi_set" && e.skill === "roi-invoices" && e.via === "mcp" && e.rate === 60));

  // A rate of 0 falls back to the gateway default; both 0 clears the record.
  roi.setDefaultRoiRate(30);
  assert.match(say(await call("update_skill", { skill: "roi-invoices", roi_hourly_rate: 0 })), /gateway default rate \(\$30\/h\)/);
  roi.setDefaultRoiRate(0);
  await call("update_skill", { skill: "roi-invoices", roi_minutes_saved: 0 });
  assert.equal(roi.getRoiAssignment("skill", "", "roi-invoices"), null);
  assert.match(say(await call("get_skill_info", { skill: "roi-invoices" })), /ROI: not set/);

  // Files and ROI in one call: a new revision and the ROI line.
  const both = await call("update_skill", { skill: "roi-invoices", files: [md("Roi Invoices", "Reconcile invoices v2")], roi_minutes_saved: 10, roi_hourly_rate: 50 });
  assert.match(say(both), /is now revision 2[\s\S]*ROI: saves 10 min per use at \$50\/h/);
});

test("create_skill without ROI says to ask; an invalid number writes nothing", async () => {
  await setUser("U_ROI_ASK", { name: "Roi Ask", approved: true });
  const call = await toolsFor("C_ROI_ASK", "U_ROI_ASK");
  assert.match(say(await call("create_skill", { files: [md("Roi Unset", "No inputs yet")] })), /ROI: not set — ask how many minutes one use saves/);
  const refused = await call("create_skill", { files: [md("Roi Bad", "Never created")], roi_minutes_saved: -5 });
  assert.match(say(refused), /Could not create the skill: Time saved must be a number/);
  assert.equal(catalog.getSkill("roi-bad"), null);
  assert.match(say(await call("update_skill", { skill: "roi-unset", roi_hourly_rate: 1e9 })), /hourly rate can be 100,000 at most/);
  assert.equal(roi.getRoiAssignment("skill", "", "roi-unset"), null);
});

test("only the skill's editors set its ROI; an admin may set it on a synced skill it cannot edit", async () => {
  await setUser("U_ROI_PLAIN", { name: "Roi Plain", approved: true });
  await setUser("U_ROI_ADMIN", { name: "Roi Admin", approved: true, isAdmin: true });
  catalog.putSkillRevision({ files: [md("Roi Synced", "A bundled skill")], ownerKind: "bundled", status: "active" });
  catalog.setSkillDiscoverable?.("roi-synced", true);

  const member = await toolsFor("C_ROI_PLAIN", "U_ROI_PLAIN");
  const refused = await member("update_skill", { skill: "roi-synced", roi_minutes_saved: 15 });
  assert.match(say(refused), /ROI not changed: only an admin/);
  assert.equal(roi.getRoiAssignment("skill", "", "roi-synced"), null);

  const admin = await toolsFor("C_ROI_ADMIN", "U_ROI_ADMIN");
  assert.match(say(await admin("update_skill", { skill: "roi-synced", roi_minutes_saved: 15, roi_hourly_rate: 80 })), /ROI inputs saved[\s\S]*saves 15 min per use at \$80\/h/);
  // A file edit on it is still refused (companion skill), and the ROI part still lands.
  const mixed = await admin("update_skill", { skill: "roi-synced", files: [md("Roi Synced", "edited")], roi_minutes_saved: 12 });
  assert.match(say(mixed), /cannot write to that source[\s\S]*ROI: saves 12 min per use at \$80\/h/);
});
