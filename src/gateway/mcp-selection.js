// Persist only newly admitted optional capabilities. Existing selections remain portable and
// are checked/dropped again at run time; unrelated saves must not destroy those stored grants.
import { requireAdapter } from '../engines/registry.js';

const selectionKey = entry => JSON.stringify([entry?.name, entry?.namespace,
  entry?.match?.serverName, entry?.match?.serverUrl,
  entry?.id, entry?.kind, entry?.serverName, entry?.toolPrefix]);

export async function assertNewMcpSelections(engine, selections = [], previous = [], options = {}) {
  const same = new Set((Array.isArray(previous) ? previous : []).map(selectionKey));
  const added = (Array.isArray(selections) ? selections : []).filter(entry => !same.has(selectionKey(entry)));
  if (!added.length) return;
  const adapter = requireAdapter(engine);
  if (typeof adapter.resolveOptionalMcpConfig !== 'function') return;
  const { rejected = [] } = await adapter.resolveOptionalMcpConfig(added, options);
  if (rejected.length) {
    const error = new Error(rejected.map(entry => `${entry.name}: ${entry.reason}`).join('; '));
    error.code = 'mcp_selection_unavailable';
    throw error;
  }
}
