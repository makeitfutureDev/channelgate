// Decorate the completed form, after draft remapping and input/roster bookkeeping. Containers
// remain in the same card so Execute and Submit collect the same inputs as the original form.
export function settingsPanels(content, sectionTitle) {
  const panels = [], apply = [], utilities = [];
  let items = [];
  const flush = () => {
    if (!items.length) return;
    if (items.length === 1 && items[0].type === 'TextBlock' && items[0].weight !== 'Bolder') {
      panels.push({ ...items[0], size: 'Small', isSubtle: true, spacing: 'Medium' });
    } else panels.push({ type: 'Container', style: 'emphasis', spacing: 'Medium', items });
    items = [];
  };
  for (const row of content.body) {
    if (row.type === 'ActionSet') {
      const scoped = row.actions.filter(action => ['settings.runtime.apply', 'settings.draft.apply', 'settings.automation.apply'].includes(action.verb));
      apply.push(...scoped);
      utilities.push(...row.actions.filter(action => action.verb === 'settings.general.discard'));
      const other = row.actions.filter(action => !scoped.includes(action) && action.verb !== 'settings.general.discard');
      if (other.length) items.push({ ...row, spacing: 'Small', actions: other });
      continue;
    }
    if (row.type === 'TextBlock' && row.separator && row.weight === 'Bolder') {
      flush();
      items.push({ ...row, size: 'Medium', color: 'Accent', spacing: 'None', separator: false });
    } else items.push({ ...row, spacing: row.type?.startsWith('Input.') ? 'Small' : row.spacing || 'Small' });
  }
  flush();
  const other = [...utilities];
  for (const action of content.actions || []) {
    if (action.verb === 'settings.automation.apply') apply.push(action);
    else other.push(action);
  }
  if (other.length) panels.push({ type: 'ActionSet', spacing: 'Medium', actions: other });
  if (apply.length) panels.push({ type: 'Container', style: 'emphasis', spacing: 'Medium', items: [
    { type: 'TextBlock', text: `Save ${sectionTitle}`, wrap: true, weight: 'Bolder' },
    { type: 'TextBlock', text: 'Save all pending changes in this section only', wrap: true, size: 'Small', isSubtle: true, spacing: 'Small' },
    { type: 'ActionSet', spacing: 'Medium', actions: apply },
  ] });
  return panels;
}
