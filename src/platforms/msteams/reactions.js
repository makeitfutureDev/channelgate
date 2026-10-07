// Microsoft Teams reaction IDs, plus the Unicode/legacy aliases used by older activities.
// These intents are explicit controls; the reacted message body never supplies a command.
export function teamsReactionAction(value) {
  // Accept the picker shortcut spelling as well as bare event IDs. Unpaired/doubled
  // colons stay unknown; normal message text never reaches this reaction mapper.
  const name = String(value || '').replace(/\uFE0F/g, '').toLowerCase().trim()
    .replace(/^:([a-z0-9_]+(?:-tone[1-5])?):$/, '$1');
  // Like is Teams' standard activation reaction. Graph can return its Unicode form,
  // including a skin tone; native activities use the documented `like` ID.
  if (/^👍[\u{1F3FB}-\u{1F3FF}]?$/u.test(name) || /^like(?:-tone[1-5])?$/.test(name)) return 'engage';
  if (['🤖', 'robot', 'robot_face', 'smilerobot', 'hearteyesrobot'].includes(name)) return 'engage';
  if (['🛑', 'stopsign', 'stop_sign', 'octagonal_sign'].includes(name)) return 'stop';
  if (['✅', '2705_whiteheavycheckmark', 'white_check_mark'].includes(name)) return 'ack';
  return '';
}

// These spellings were ignored before the shortcut/Like expansion. Graph history can contain
// old current reactions, so they need a persisted introduction cutoff before replay admission.
export function teamsReactionRequiresCutover(value) {
  const raw = String(value || '').replace(/\uFE0F/g, '').toLowerCase();
  return Boolean(teamsReactionAction(value)) && (raw.includes(':') || raw !== raw.trim()
    || /^👍/u.test(raw) || /^like(?:-tone[1-5])?$/.test(raw));
}
