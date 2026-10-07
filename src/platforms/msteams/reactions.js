// Microsoft Teams reaction IDs, plus the Unicode/legacy aliases used by older activities.
// These intents are explicit controls; the reacted message body never supplies a command.
export const DEFAULT_TEAMS_ACTIVATION_REACTIONS = Object.freeze(['hearteyesrobot', 'alien', 'like', 'smilerobot']);

export function teamsReactionKey(value) {
  // Accept the picker shortcut spelling as well as bare event IDs. Unpaired/doubled
  // colons stay unknown; normal message text never reaches this reaction mapper.
  const name = String(value || '').replace(/\uFE0F/g, '').toLowerCase().trim()
    .replace(/^:([a-z0-9_]+(?:-tone[1-5])?):$/, '$1');
  // Like is Teams' standard activation reaction. Graph can return its Unicode form,
  // including a skin tone; native activities use the documented `like` ID.
  if (/^👍[\u{1F3FB}-\u{1F3FF}]?$/u.test(name) || /^like(?:-tone[1-5])?$/.test(name)) return 'like';
  if (['👽', 'alien', '1f47d_extraterrestrialalien'].includes(name)) return 'alien';
  if (['🤖', 'robot', 'robot_face', 'smilerobot'].includes(name)) return 'smilerobot';
  if (name === 'hearteyesrobot') return name;
  if (name === 'heart') return '❤';
  if (['🛑', 'stopsign', 'stop_sign', 'octagonal_sign'].includes(name)) return 'control:stop';
  if (['✅', '2705_whiteheavycheckmark', 'white_check_mark'].includes(name)) return 'control:ack';
  // Standard reference IDs start with their Unicode code point (e.g. 1f680_rocket).
  // Keep named robot variants separate: Graph requires metadata to identify them.
  const hex = /^([a-f0-9]{4,6})_[a-z0-9_]+(?:-tone([1-5]))?$/.exec(name);
  if (hex && Number.parseInt(hex[1], 16) <= 0x10ffff) {
    const point = Number.parseInt(hex[1], 16);
    if (point >= 0xd800 && point <= 0xdfff) return name;
    const key = teamsReactionKey(String.fromCodePoint(point) + (hex[2] ? String.fromCodePoint(0x1f3fa + Number(hex[2])) : ''));
    return key.startsWith('control:') ? name : key;
  }
  return name;
}

export function teamsActivationFingerprint(reactions = DEFAULT_TEAMS_ACTIVATION_REACTIONS) {
  return JSON.stringify([...new Set(reactions.map(teamsReactionKey))].sort());
}

export function teamsReactionAction(value, activationReactions = DEFAULT_TEAMS_ACTIVATION_REACTIONS) {
  const key = teamsReactionKey(value);
  if (key === 'control:stop' || key === 'control:ack') return key.slice(8);
  return key && activationReactions.some(item => teamsReactionKey(item) === key) ? 'engage' : '';
}

// Each expansion needs its own persisted introduction cutoff. A cutoff from an earlier
// deployment cannot prevent newly supported reactions replaying pre-upgrade history.
export function teamsReactionCutoverField(value) {
  const raw = String(value || '').replace(/\uFE0F/g, '').toLowerCase();
  const name = raw.trim().replace(/^:([a-z0-9_]+):$/, '$1');
  if (['👽', 'alien', '1f47d_extraterrestrialalien'].includes(name)) return 'alienReactionStartedAt';
  return teamsReactionAction(value) && (raw.includes(':') || raw !== raw.trim()
    || /^👍/u.test(raw) || /^like(?:-tone[1-5])?$/.test(raw)) ? 'reactionAliasesStartedAt' : '';
}


// Graph can collapse a Teams picker variant onto its standard Unicode value. Never turn
// ordinary Heart eyes into activation: require the provider's exact robot name and no custom art.
export function teamsGraphReactionAction(reaction, activationReactions = DEFAULT_TEAMS_ACTIVATION_REACTIONS) {
  const type = String(reaction?.reactionType || '').replace(/\uFE0F/g, '');
  if (type === '😍' && reaction?.displayName === 'Heart eyes robot' && !reaction.reactionContentUrl) {
    return teamsReactionAction('hearteyesrobot', activationReactions);
  }
  return teamsReactionAction(reaction?.reactionType, activationReactions);
}

export function teamsGraphReactionCutoverField(reaction) {
  if (teamsReactionAction(reaction?.reactionType)) return teamsReactionCutoverField(reaction.reactionType);
  return teamsGraphReactionAction(reaction) === 'engage' ? 'graphRobotStartedAt' : '';
}
