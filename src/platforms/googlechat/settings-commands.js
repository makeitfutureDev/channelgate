// Typed `/settings <option> <value>` commands. They reach the gateway the way every message does,
// so they keep working where Chat cannot deliver card clicks (a Pub/Sub-connected app). Each one
// maps onto the SAME guarded General-settings action the card buttons call — authorization,
// manager checks, mode policy and audit stay in one place.
import { RUNTIME_DEFAULT_VALUE } from '../../gateway/runtime-settings.js';

const ACCESS = {
  mode: { field: 'mode', values: ['read', 'worker', 'admin'] },
  access: { field: 'access', values: ['approved', 'admins', 'none'] },
  managers: { field: 'manageAccess', values: ['admins', 'members', 'custom'] },
  auto: { field: 'autoMode', values: ['on', 'off'] },
  lean: { field: 'cleanMode', values: ['on', 'off'] },
  network: { field: 'allowNetwork', values: ['on', 'off'] },
};
const RUNTIME = ['engine', 'model', 'effort'];

export const GOOGLE_CHAT_SETTINGS_COMMANDS = [
  '`/settings mode read|worker|admin`',
  '`/settings auto on|off` · `/settings lean on|off` · `/settings network on|off`',
  '`/settings access approved|admins|none` · `/settings managers admins|members|custom`',
  '`/settings vpn on|off`',
  '`/settings [thread|channel] engine|model|effort <value|default>` (thread is the default)',
];
export const GOOGLE_CHAT_SETTINGS_USAGE = ['Change a setting by typing one of:', ...GOOGLE_CHAT_SETTINGS_COMMANDS].join('\n');

// Returns { action, data } for a supported command, or { error } with the usage text.
export function parseSettingsCommand(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const usage = message => ({ error: `${message}\n\n${GOOGLE_CHAT_SETTINGS_USAGE}` });
  if (!words.length || /^(help|\?)$/i.test(words[0])) return usage('Typed settings commands:');
  const key = words[0].toLowerCase();
  if (ACCESS[key]) {
    const value = String(words[1] || '').toLowerCase();
    if (words.length !== 2 || !ACCESS[key].values.includes(value)) return usage(`Use \`/settings ${key} ${ACCESS[key].values.join('|')}\`.`);
    const { field } = ACCESS[key];
    return { action: 'settings.access', data: { field, [`access_${field}`]: value } };
  }
  if (key === 'vpn') {
    const value = String(words[1] || '').toLowerCase();
    if (words.length !== 2 || !['on', 'off'].includes(value)) return usage('Use `/settings vpn on|off`.');
    return { action: 'settings.vpn', data: { enabled: value === 'on' } };
  }
  const scoped = ['thread', 'channel'].includes(key);
  const scope = scoped ? key : 'thread';
  const [field, value, ...rest] = scoped ? words.slice(1) : words;
  if (RUNTIME.includes(String(field || '').toLowerCase()) && value && !rest.length) {
    const name = field.toLowerCase();
    return { action: 'settings.runtime', data: { scope, field: name,
      [`${scope}_${name}`]: /^default$/i.test(value) ? RUNTIME_DEFAULT_VALUE : name === 'model' ? value : value.toLowerCase() } };
  }
  return usage(`Unknown settings command \`${words.join(' ').slice(0, 80)}\`.`);
}
