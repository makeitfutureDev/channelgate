import { harnessOf, isEngineId } from "../engines/registry.js";
import { effectiveMeta } from "./effective-meta.js";
import { harnessSelection, impliedLicensePool, LICENSE_POOL_ANY, readLicensePool } from "./license-pool.js";
import { getThreadClean, getThreadEffort, getThreadEngine, getThreadLicensePool, getThreadModel } from "./thread-engine.js";

type LicensePool = "" | "any" | string[];
interface Source {
  slug: string;
  threadKey: string;
  engine: string;
  meta: Record<string, unknown>;
}
export interface ForkSettings {
  engine: string;
  model: string;
  effort: string;
  licensePool: LicensePool;
  clean: boolean;
}

// A moved session starts the fork on its current license, retaining the other licenses in
// source order. A shortcut outside that selection has no claim on the source's license pool.
async function inheritedPool({ slug, threadKey, engine, meta }: Source): Promise<LicensePool> {
  const harness = harnessOf(engine);
  if (!harness || !isEngineId(engine)) return "";
  const pinned = await getThreadEngine(slug, threadKey);
  const selection = pinned
    ? { engine: pinned, licensePool: await getThreadLicensePool(slug, threadKey) }
    : harnessSelection(harness, effectiveMeta(meta));
  if (harnessOf(selection.engine) !== harness) return "";
  const pool = readLicensePool(selection.licensePool);
  if (pool === LICENSE_POOL_ANY) return LICENSE_POOL_ANY;
  const licenses = [selection.engine, ...(Array.isArray(pool) ? pool : [])];
  if (!licenses.includes(engine)) return "";
  const rest = [...new Set(licenses)].filter(id => id !== engine && isEngineId(id) && harnessOf(id) === harness);
  return rest.length ? rest : "";
}

export async function resolveForkSettings(source: Source, shortcut?: { model: string; effort: string }): Promise<ForkSettings> {
  const { slug, threadKey, engine, meta } = source;
  const clean = Boolean(meta.cleanMode || await getThreadClean(slug, threadKey));
  if (shortcut) {
    return { engine, model: shortcut.model, effort: shortcut.effort, clean, licensePool: impliedLicensePool(engine, effectiveMeta(meta)) };
  }
  return {
    engine, clean, licensePool: await inheritedPool(source),
    model: await getThreadModel(slug, threadKey), effort: await getThreadEffort(slug, threadKey),
  };
}
