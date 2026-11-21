// The Teams settings window's layout: a full-width Adaptive Card 1.4 with a compact header,
// two-column section navigation, the section's settings grouped into panels and ONE Save area at
// the end. Teams renders at most six actions per action set, so every action set here holds at most
// six; the card's own `actions` stay empty. Containers do not change what an action submits: every
// input on the card is still collected by an `auto` action.
const text = (value, extra = {}) => ({ type: 'TextBlock', text: String(value).slice(0, 2400), wrap: true, ...extra });
const MAX_ACTIONS = 6;

function cell(action) {
  return { type: 'Column', width: 'stretch', items: [{ type: 'ActionSet', actions: [action] }] };
}

// Six sections as three rows of two: long labels stay readable on narrow desktop and mobile panes.
export function navigationRows(tabs) {
  const rows = [];
  for (let index = 0; index < tabs.length; index += 2) {
    rows.push({ type: 'ColumnSet', spacing: index ? 'Small' : 'Medium', columns: tabs.slice(index, index + 2).map(cell) });
  }
  return rows;
}

// Split a page's rows into panels: each bold heading opens a new emphasis container.
export function settingsPanels(body = []) {
  const panels = [];
  let items = [];
  const flush = () => {
    if (items.length) panels.push({ type: 'Container', style: 'emphasis', spacing: 'Medium', items });
    items = [];
  };
  for (const row of body) {
    if (row?.type === 'TextBlock' && row.weight === 'Bolder' && row.separator) {
      flush();
      items.push({ ...row, separator: false, spacing: 'None', color: 'Accent' });
      continue;
    }
    if (row?.type === 'ActionSet') {
      for (let index = 0; index < row.actions.length; index += MAX_ACTIONS) items.push({ ...row, spacing: 'Small', actions: row.actions.slice(index, index + MAX_ACTIONS) });
      continue;
    }
    items.push({ ...row, spacing: row?.type?.startsWith?.('Input.') ? 'Small' : row?.spacing || 'Small' });
  }
  flush();
  return panels;
}

// The one Save area of a section: Apply to channel, Apply to thread (only when opened from a
// thread), Follow channel (clears this thread's overrides) and Discard.
export function saveArea(save, ui) {
  const apply = [ui.execute('Apply to channel', save.verb, { ...save.data, scope: 'channel' }), ...(save.thread ? [ui.execute('Apply to thread', save.verb, { ...save.data, scope: 'thread' })] : [])]
    .map(action => ({ ...action, style: 'positive' }));
  const other = [...(save.follow ? [ui.execute('Follow channel (stage)', 'settings.draft.follow', save.data, 'none')] : []),
    ...(save.discard ? [ui.execute('Discard changes', save.discard, save.data, 'none')] : [])];
  return { type: 'Container', style: 'emphasis', spacing: 'Large', items: [
    text(`Save ${save.title}`, { weight: 'Bolder', spacing: 'None' }),
    text(save.pending ? `${save.pending} pending change${save.pending === 1 ? '' : 's'}. Apply saves this section only; other sections keep their pending changes.` : 'No pending changes in this section. Apply saves this section only.', { size: 'Small', isSubtle: true, spacing: 'Small' }),
    { type: 'ActionSet', spacing: 'Small', actions: [...apply, ...other].slice(0, MAX_ACTIONS) },
  ] };
}

export function teamsSettingsCard({ title, subtitle, notice, pendingElsewhere = [], tabs, content, ui }) {
  const body = [
    text(title, { size: 'Large', weight: 'Bolder', spacing: 'None' }),
    text(subtitle, { size: 'Small', isSubtle: true, spacing: 'None' }),
    ...navigationRows(tabs),
  ];
  if (pendingElsewhere.length) body.push(text(`Pending, not saved yet: ${pendingElsewhere.join(' · ')}`, { size: 'Small', color: 'Warning', spacing: 'Small' }));
  if (notice) body.push({ type: 'Container', style: 'accent', spacing: 'Medium', items: [text(notice, { size: 'Small' })] });
  body.push(...settingsPanels(content.body));
  if (content.actions?.length) body.push({ type: 'ActionSet', spacing: 'Medium', actions: content.actions.slice(0, MAX_ACTIONS) });
  if (content.save) body.push(saveArea(content.save, ui));
  return { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', msteams: { width: 'Full' }, body, actions: [] };
}
