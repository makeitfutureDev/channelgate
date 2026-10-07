// Microsoft Teams reaction IDs, plus the Unicode/legacy aliases used by older activities.
// These intents are explicit controls; the reacted message body never supplies a command.
export function teamsReactionAction(value) {
  const name = String(value || '').replace(/\uFE0F/g, '').toLowerCase();
  if (['🤖', 'robot', 'robot_face', 'smilerobot', 'hearteyesrobot'].includes(name)) return 'engage';
  if (['🛑', 'stopsign', 'stop_sign', 'octagonal_sign'].includes(name)) return 'stop';
  if (['✅', '2705_whiteheavycheckmark', 'white_check_mark'].includes(name)) return 'ack';
  return '';
}
