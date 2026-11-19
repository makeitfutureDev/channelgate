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
  skillswap: { field: 'skillRuntimeSwap', values: ['on', 'off'] },
};
// `harness` is the word people see; the action's field is still `engine`. `license` names licenses
// of the harness the scope is on, by label, id or list number (src/platforms/license-choice.js).
const RUNTIME = { harness: 'engine', engine: 'engine', model: 'model', effort: 'effort' };

export const GOOGLE_CHAT_SETTINGS_COMMANDS = [
  '`/settings mode read|worker|admin`',
  '`/settings auto on|off` · `/settings lean on|off` · `/settings network on|off` · `/settings skillswap on|off`',
  '`/settings access approved|admins|none` · `/settings managers admins|members|custom`',
  '`/settings vpn on|off`',
  '`/settings [thread|channel] harness|model|effort <value|default>` (thread is the default)',
  '`/settings [thread|channel] license <any|name[, name…]|default>` — where the harness has several licenses; `/license` lists them',
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
  // License names may hold spaces and several are separated by commas, so the rest of the line is
  // the value. Matching is case-insensitive; the names are kept as typed.
  if (/^licen[sc]es?$/i.test(String(field || '')) && value) {
    const typed = [value, ...rest].join(' ').slice(0, 2000);
    return { action: 'settings.runtime', data: { scope, field: 'license', [`${scope}_license`]: /^default$/i.test(typed) ? RUNTIME_DEFAULT_VALUE : typed } };
  }
  if (Object.hasOwn(RUNTIME, String(field || '').toLowerCase()) && value && !rest.length) {
    const name = RUNTIME[field.toLowerCase()];
    return { action: 'settings.runtime', data: { scope, field: name,
      [`${scope}_${name}`]: /^default$/i.test(value) ? RUNTIME_DEFAULT_VALUE : name === 'model' ? value : value.toLowerCase() } };
  }
  return usage(`Unknown settings command \`${words.join(' ').slice(0, 80)}\`.`);
}
