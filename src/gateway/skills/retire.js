// Capabilities promoted into the always-present gateway-usage guide must stop behaving like
// optional catalog grants. This idempotent boot repair excludes their old catalog entries and
// removes their raw grant names from every durable tier. The access-grant sanitizer independently
// filters them at the run boundary, so a stale file or a concurrent old process cannot reactivate
// the standalone copy while this repair is pending.
import { getDb } from "../../db/index.js";
import { getSettings, saveSettings } from "../../config/settings.js";
import { RETIRED_STANDALONE_SKILLS } from "../access-grants.js";
import { excludeSkill } from "./catalog.js";

const retired = new Set(RETIRED_STANDALONE_SKILLS.map((name) => name.toLowerCase()));

function withoutRetired(value) {
  if (!Array.isArray(value)) return value;
  return value.filter((name) => typeof name !== "string" || !retired.has(name.trim().toLowerCase()));
}

function cleanRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return { value: record, changed: false };
  const next = { ...record };
  let changed = false;
  if (Array.isArray(record.skills)) {
    next.skills = withoutRetired(record.skills);
    changed ||= next.skills.length !== record.skills.length;
  }
  return { value: next, changed };
}

function cleanJsonRows(db, table, keyColumn) {
  let changed = 0;
  const update = db.prepare(`UPDATE ${table} SET data = ? WHERE ${keyColumn} = ?`);
  for (const row of db.prepare(`SELECT ${keyColumn} AS key, data FROM ${table}`).all()) {
    let parsed;
    try { parsed = JSON.parse(row.data); } catch { continue; }
    const cleaned = cleanRecord(parsed);
    if (!cleaned.changed) continue;
    update.run(JSON.stringify(cleaned.value), row.key);
    changed++;
  }
  return changed;
}

function cleanSettings() {
  const settings = getSettings();
  const patch = {};
  let changed = false;
  const org = cleanRecord(settings.accessGrants);
  if (org.changed) { patch.accessGrants = org.value; changed = true; }
  const channel = cleanRecord(settings.channelTemplate);
  if (channel.changed) { patch.channelTemplate = channel.value; changed = true; }
  if (settings.dmTemplates && typeof settings.dmTemplates === "object") {
    const user = cleanRecord(settings.dmTemplates.user);
    const admin = cleanRecord(settings.dmTemplates.admin);
    if (user.changed || admin.changed) {
      patch.dmTemplates = { ...settings.dmTemplates, user: user.value, admin: admin.value };
      changed = true;
    }
  }
  if (changed) saveSettings(patch);
  return changed;
}

export function retireStandaloneGatewaySkills() {
  const db = getDb();
  let catalog = 0;
  for (const slug of RETIRED_STANDALONE_SKILLS) catalog += Number(excludeSkill(slug));
  const users = cleanJsonRows(db, "users", "user_id");
  const channels = cleanJsonRows(db, "channel_meta", "slug");
  let templates = 0;
  const updateTemplate = db.prepare("UPDATE skill_templates SET skills = ?, updated_at = ? WHERE id = ?");
  for (const row of db.prepare("SELECT id, skills FROM skill_templates").all()) {
    let skills;
    try { skills = JSON.parse(row.skills); } catch { continue; }
    const next = withoutRetired(skills);
    if (!Array.isArray(next) || next.length === skills.length) continue;
    updateTemplate.run(JSON.stringify(next), new Date().toISOString(), row.id);
    templates++;
  }
  const settings = Number(cleanSettings());
  return { catalog, users, channels, templates, settings };
}
