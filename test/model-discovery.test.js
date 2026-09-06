import test from "node:test";
import assert from "node:assert/strict";
import { discoverCodexModels } from "../src/engines/model-discovery.js";
import { createEngineModelCatalog } from "../src/engines/registry.js";

function execResult(payload, { error = null, stderr = "" } = {}) {
  return (_command, _args, _options, callback) => queueMicrotask(() => callback(
    error,
    typeof payload === "string" ? payload : JSON.stringify(payload),
    stderr,
  ));
}

test("Codex discovery exposes only live picker models and their supported efforts", async () => {
  const models = await discoverCodexModels({ execFileImpl: execResult({ models: [
    {
      slug: "gpt-6-astra",
      display_name: "GPT-6-Astra",
      description: "Most capable.",
      visibility: "list",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low" }, { effort: "medium" }, { effort: "ultra" }, { effort: "ultra" },
      ],
    },
    { slug: "gpt-retired", display_name: "Retired", visibility: "hide", supported_reasoning_levels: [] },
    { slug: "../../bad", display_name: "Bad", visibility: "list", supported_reasoning_levels: [] },
  ] }) });

  assert.deepEqual(models, [{
    value: "gpt-6-astra",
    label: "GPT-6-Astra",
    description: "Most capable.",
    efforts: ["low", "medium", "ultra"],
    defaultEffort: "medium",
  }]);
});

test("Codex discovery rejects malformed and empty catalogs", async () => {
  await assert.rejects(
    discoverCodexModels({ execFileImpl: execResult("not json") }),
    /malformed JSON/,
  );
  await assert.rejects(
    discoverCodexModels({ execFileImpl: execResult({ models: [{ slug: "gpt-hidden", visibility: "hide" }] }) }),
    /no selectable models/,
  );
});

function fakeRegistry(discoverModels) {
  const adapter = {
    id: "codex",
    label: "Codex",
    efforts: ["none", "low", "medium", "high", "xhigh", "max", "ultra"],
    models: [{ value: "codex", label: "Codex", description: "Bundled fallback." }],
    modelBelongs: (model) => /^(?:gpt-|codex)/.test(model),
    discoverModels,
  };
  return {
    ids: ["codex"],
    require: (id) => {
      if (id !== "codex") throw new Error("unknown");
      return adapter;
    },
    manifests: () => [{ id: "codex", label: "Codex", efforts: [...adapter.efforts], models: structuredClone(adapter.models) }],
  };
}

test("shared catalog caches live discovery, maps per-model effort, and keeps last good on failure", async () => {
  let at = 1_000;
  let calls = 0;
  let fail = false;
  const registry = fakeRegistry(async () => {
    calls += 1;
    if (fail) throw new Error("offline");
    return [{ value: "gpt-6-astra", label: "Astra", efforts: ["low", "medium", "ultra"] }];
  });
  const messages = [];
  const catalog = createEngineModelCatalog(registry, { ttlMs: 100, now: () => at, log: (message) => messages.push(message) });

  assert.equal(catalog.snapshot("codex").source, "fallback");
  assert.deepEqual(catalog.snapshot("codex").models.map((model) => model.value), ["codex"]);

  await catalog.refresh("codex");
  assert.equal(calls, 1);
  assert.equal(catalog.snapshot("codex").source, "live");
  assert.deepEqual(catalog.effortsFor("codex", "gpt-6-astra"), ["low", "medium", "ultra"]);
  assert.deepEqual(catalog.manifests()[0].models.map((model) => model.value), ["gpt-6-astra"]);

  await catalog.refresh("codex");
  assert.equal(calls, 1, "fresh cache avoids another CLI probe");

  at += 101;
  fail = true;
  await catalog.refresh("codex");
  assert.equal(calls, 2);
  assert.equal(catalog.snapshot("codex").source, "cached");
  assert.deepEqual(catalog.snapshot("codex").models.map((model) => model.value), ["gpt-6-astra"]);
  assert.match(messages[0], /using cached catalog/);
});

test("a cold discovery failure retains the bundled fallback", async () => {
  const catalog = createEngineModelCatalog(fakeRegistry(async () => { throw new Error("missing CLI"); }), { log: () => {} });
  await catalog.refresh("codex");
  assert.equal(catalog.snapshot("codex").source, "fallback");
  assert.deepEqual(catalog.snapshot("codex").models.map((model) => model.value), ["codex"]);
});
