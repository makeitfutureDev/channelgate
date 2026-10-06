// Shared runtime-field validation for native conversation settings. Callers retain authority;
// these helpers only resolve inheritance and validate the engine-specific runtime triple.
import { getEngine, getEnabledEngines, getDefaultModel } from '../config/settings.js';
import { modelBelongsToEngine, effortBelongsToModel } from '../engines/registry.js';

export const RUNTIME_DEFAULT_VALUE = '__default__';
export const RUNTIME_FIELDS = Object.freeze(['engine', 'model', 'effort']);
const clean = value => value === RUNTIME_DEFAULT_VALUE ? '' : String(value || '').trim();

export function nextRuntimeTriple(current = {}, field, value, inheritedEngine) {
  if (!RUNTIME_FIELDS.includes(field)) throw new Error('Unknown runtime control.');
  const next = { engine: clean(current.engine), model: clean(current.model), effort: clean(current.effort), [field]: clean(value) };
  const engine = next.engine || inheritedEngine;
  if (!modelBelongsToEngine(next.model, engine)) next.model = '';
  if (!effortBelongsToModel(next.effort, engine, next.model || getDefaultModel(engine))) next.effort = '';
  return next;
}

export function runtimeSettingsPatch(form = {}, { gatewayEngine = getEngine(), enabledEngines = getEnabledEngines() } = {}) {
  const engine = clean(form.engine), actualEngine = engine || gatewayEngine;
  if (!enabledEngines.includes(actualEngine)) throw new Error('That engine is no longer enabled.');
  const model = clean(form.model), effort = clean(form.effort);
  if (model && !modelBelongsToEngine(model, actualEngine)) throw new Error('That model does not belong to the selected engine.');
  if (effort && !effortBelongsToModel(effort, actualEngine, model || getDefaultModel(actualEngine))) throw new Error('That effort is not supported by the selected model.');
  return { patch: { engine, model, effort }, actualEngine };
}
