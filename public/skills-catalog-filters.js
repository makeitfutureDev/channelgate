const directAssignmentSlugs = (overview = {}, profiles = []) => {
  const assigned = new Set();
  const add = (slugs) => {
    for (const slug of slugs || []) assigned.add(String(slug).toLowerCase());
  };
  add(overview.orgSkills);
  const templates = new Map((overview.templates || []).map((template) => [String(template.slug).toLowerCase(), template]));
  for (const profile of profiles || []) {
    add(profile.own);
    add(profile.section);
    const template = templates.get(String(profile.skillTemplate || "").toLowerCase());
    add(template?.resolved);
  }
  return assigned;
};

const matchesBoolean = (value, filter) => filter === "all" || filter === "" || Boolean(value) === (filter === "1");

// The API applies these filters too, but the browser deliberately enforces them on the returned
// rows. Static assets can be served from a newly landed checkout before the long-running daemon
// has restarted; the controls must not become cosmetic during that window.
export function filterSkillCatalog(skills = [], filters = {}, { overview = {}, profiles = [] } = {}) {
  const assigned = directAssignmentSlugs(overview, profiles);
  return skills.map((skill) => ({
    ...skill,
    assigned: assigned.has(String(skill.slug).toLowerCase()),
  })).filter((skill) => (
    matchesBoolean(skill.enabled, filters.enabled)
    && matchesBoolean(skill.discoverable, filters.discoverable)
    && matchesBoolean(skill.mandatory, filters.mandatory)
    && matchesBoolean(skill.assigned, filters.assigned)
  ));
}
