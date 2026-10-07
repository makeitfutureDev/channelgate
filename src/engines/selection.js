// Selection admission is separate from CLI health and run-time failure handling. Optional
// providers prove their own configuration; a missing key must not overwrite an existing pin or
// quietly select another provider. This never dials a provider or returns credential material.
import { requireAdapter } from './registry.js';
import { isEngineEnabled } from '../config/settings.js';

const refuse = message => { const error = new Error(message); error.code = 'engine_selection_unavailable'; throw error; };

export async function assertEngineSelectable(engine, { settingsPatch = {} } = {}) {
  const adapter = requireAdapter(engine);
  const enabled = typeof settingsPatch.engineEnabled?.[engine] === 'boolean'
    ? settingsPatch.engineEnabled[engine] : isEngineEnabled(engine);
  if (!enabled) refuse(`${adapter.label} is disabled — enable it in Settings before selecting it.`);
  if (typeof adapter.selectionReadiness !== 'function') return;
  const state = await adapter.selectionReadiness({ settingsPatch });
  if (state?.ready !== true) refuse(`${adapter.label} is not configured: ${state?.reason || 'configure its credential and endpoint in Settings'}.`);
}
