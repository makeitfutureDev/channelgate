// Engine licenses for PROVIDERS: an API key or custom server, Amazon Bedrock, Google Vertex AI and
// Microsoft Azure, for both harnesses. What is proved here is the gateway's half — what is stored,
// what a listing returns, where a credential may be swapped in, and which settings each CLI is
// started with. No test talks to a real provider.
import test from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const { createFakeRuntime } = await import("./fixtures/fake-runtime-backend.js");
const { saveSettings } = await import("../src/config/settings.js");
const store = await import("../src/config/engine-licenses.js");
const registry = await import("../src/engines/registry.js");
const facts = await import("../src/engines/license-state.js");
const adapters = await import("../src/engines/license-adapters.js");
const vertex = await import("../src/gateway/vertex-token.js");
const { relayRuleFor } = await import("../src/gateway/egress/catalog-rules.js");
const grants = await import("../src/gateway/egress/grants.js");
const { buildCodexArgs, buildCodexEnv } = await import("../src/engines/codex.js");
const { buildClaudeEnv } = await import("../src/engines/claude.js");

const reset = () => { saveSettings({ engineLicenses: [], engine: "claude", enginePool: "", engineEnabled: { claude: true, codex: true } }); vertex.__resetVertexTokens(); };
const KEY = "fixture-provider-key-0001";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const serviceAccountFile = (extra = {}) => JSON.stringify({
  type: "service_account", project_id: "fixture-project-1", private_key_id: "kid-fixture", private_key: PEM,
  client_email: "runner@fixture-project-1.iam.gserviceaccount.com", token_uri: "https://attacker.example/token", ...extra,
});
const INPUTS = {
  "codex-api": { label: "OpenAI API", type: "api", apiKey: KEY },
  "codex-aws": { label: "Codex Bedrock", type: "api", region: "eu-central-1", apiKey: KEY, models: ["openai.gpt-6.2-sol"] },
  "codex-gcp": { label: "Codex Vertex", type: "api", region: "global", serviceAccount: serviceAccountFile(), models: ["gpt-6.2-sol"] },
  "codex-azure": { label: "Codex Azure", type: "enterprise", baseUrl: "https://acme.openai.azure.com/openai/v1", apiKey: KEY, authScheme: "api-key", apiVersion: "2025-04-01-preview", models: ["gpt-deploy"] },
  "claude-api": { label: "Claude custom", type: "api", baseUrl: "https://llm.example.com", apiKey: KEY, authScheme: "bearer", models: ["team-large"] },
  "claude-aws": { label: "Claude Bedrock", type: "api", region: "eu-central-1", apiKey: KEY },
  "claude-gcp": { label: "Claude Vertex", type: "api", region: "europe-west1", serviceAccount: serviceAccountFile() },
  "claude-azure": { label: "Claude Azure", type: "enterprise", baseUrl: "https://acme.services.ai.azure.com/anthropic", apiKey: KEY },
};
const add = (kind, extra = {}) => store.createLicense({ kind, ...INPUTS[kind], ...extra });
const tokenFetch = (calls = [], { status = 200, body = { access_token: "ya29.fixture-access-token", expires_in: 3600 } } = {}) => async (url, init) => {
  calls.push({ url: String(url), init });
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
};

test("the catalog offers both harnesses a key/custom server, Bedrock, Vertex and Azure, and says what each asks for", () => {
  const catalog = store.licenseCatalog();
  const of = (harness) => catalog.kinds.filter((kind) => kind.harness === harness).map((kind) => kind.provider || "login");
  assert.deepEqual(of("claude"), ["login", "custom", "bedrock", "vertex", "azure"]);
  assert.deepEqual(of("codex"), ["login", "custom", "bedrock", "vertex", "azure"]);
  for (const kind of catalog.kinds) {
    if (!kind.provider) { assert.deepEqual(kind.fields, [], `${kind.id} asks for no typed credential`); continue; }
    assert.ok(kind.fields.includes("models"));
    assert.equal(kind.fields.includes("serviceAccount"), kind.provider === "vertex", `${kind.id}: only Vertex takes a key file`);
    assert.equal(kind.fields.includes("apiKey"), kind.provider !== "vertex");
    assert.equal(kind.fields.includes("region"), kind.provider === "bedrock" || kind.provider === "vertex");
    assert.equal(kind.fields.includes("baseUrl"), kind.provider === "custom" || kind.provider === "azure");
    assert.ok(kind.types.includes("api"));
  }
  // Every stored id has exactly one kind, read from its shape.
  for (const kind of Object.values(facts.LICENSE_KINDS)) assert.equal(facts.licenseKindOfId(`${kind.prefix}0a1b2c3d`)?.id, kind.id);
});

test("every provider kind becomes a live license of its harness and never returns its credential", () => {
  reset();
  for (const kind of Object.keys(INPUTS)) {
    const record = add(kind);
    const adapter = registry.requireAdapter(record.id);
    assert.equal(adapter.cli, facts.LICENSE_KINDS[kind].harness, `${kind} runs on its harness's CLI`);
    assert.ok(registry.licensesOfHarness(adapter.cli).some((entry) => (entry.id || entry) === record.id));
  }
  const listed = store.listLicenseRecords().map((record) => store.licenseForApi(record));
  const text = JSON.stringify(listed);
  assert.ok(!text.includes(KEY), "no API key in a listing");
  assert.ok(!text.includes("PRIVATE KEY") && !text.includes("kid-fixture"), "no service-account key in a listing");
  const byKind = Object.fromEntries(listed.map((entry) => [entry.kind, entry]));
  assert.equal(byKind["codex-aws"].apiKeyLast4, KEY.slice(-4));
  assert.equal(byKind["codex-gcp"].hasServiceAccount, true);
  assert.equal(byKind["codex-gcp"].serviceAccountEmail, "runner@fixture-project-1.iam.gserviceaccount.com");
  assert.equal(byKind["codex-gcp"].projectId, "fixture-project-1", "a blank project takes the key file's");
  assert.equal(byKind["codex-gcp"].hasApiKey, undefined);
  // Where each one talks to.
  assert.equal(byKind["codex-api"].endpoint, "https://api.openai.com/v1");
  assert.equal(byKind["codex-aws"].endpoint, "https://bedrock-mantle.eu-central-1.api.aws/openai/v1");
  assert.equal(byKind["codex-gcp"].endpoint, "https://aiplatform.googleapis.com/v1/projects/fixture-project-1/locations/global/publishers/openai/v1");
  assert.equal(byKind["claude-aws"].endpoint, "https://bedrock-runtime.eu-central-1.amazonaws.com");
  assert.equal(byKind["claude-gcp"].endpoint, "https://europe-west1-aiplatform.googleapis.com/v1");
  assert.equal(byKind["claude-azure"].endpoint, "https://acme.services.ai.azure.com/anthropic");
});

test("a provider license is refused until it names what its provider needs", () => {
  reset();
  const refused = (kind, extra, pattern) => assert.throws(() => add(kind, extra), (error) => error.status === 400 && pattern.test(error.message), `${kind} ${JSON.stringify(Object.keys(extra))}`);
  refused("codex-api", { apiKey: "" }, /API key/);
  refused("codex-api", { baseUrl: "http://llm.example.com/v1" }, /https:\/\//);
  refused("codex-api", { baseUrl: "https://llm.example.com/v1" }, /at least one model id this server serves/);
  refused("claude-api", { models: [] }, /at least one model id this server serves/);
  refused("codex-aws", { region: "europe" }, /AWS region/);
  refused("codex-aws", { models: [] }, /at least one model id to use on Amazon Bedrock/);
  refused("claude-aws", { apiKey: "" }, /Bedrock API key/);
  refused("codex-gcp", { serviceAccount: "" }, /service-account key file/);
  refused("codex-gcp", { serviceAccount: '{"type":"authorized_user","client_email":"a@b.c","private_key":"x"}' }, /whole service-account key file/);
  refused("claude-gcp", { region: "Europe West" }, /Vertex AI location/);
  refused("claude-gcp", { projectId: "Bad_Project" }, /project ID/);
  refused("codex-azure", { authScheme: "x-api-key" }, /how the key is sent/i);
  refused("codex-azure", { apiVersion: "2025 04" }, /API version/);
  refused("codex-azure", { models: [] }, /Azure/);
  refused("claude-azure", { type: "subscription" }, /is one of: API/);
  // The vendor's own API and Claude's cloud routes need no model list.
  assert.deepEqual(add("codex-api").models, []);
  assert.deepEqual(add("claude-aws").models, []);
  const cloud = registry.requireAdapter(add("claude-azure").id);
  assert.deepEqual(cloud.models.map((model) => model.value), ["opus", "sonnet", "haiku"]);
});

test("an edit keeps a stored credential when its box is left blank, and a changed one loses its verdict", async () => {
  reset();
  const record = add("codex-gcp");
  const calls = [];
  await store.verifyLicense(record.id, { fetchImpl: tokenFetch(calls) });
  assert.equal(store.getLicenseRecord(record.id).verification.ok, true);
  const renamed = store.updateLicense(record.id, { label: "Vertex EU", serviceAccount: "", models: ["gpt-6.2-sol"] });
  assert.equal(renamed.serviceAccount, record.serviceAccount, "a blank box keeps the stored key file");
  assert.equal(renamed.verification?.ok, true, "nothing the verdict is about changed");
  const moved = store.updateLicense(record.id, { region: "europe-west4" });
  assert.equal(moved.verification, null, "a new location is unverified");
  const rekeyed = store.updateLicense(record.id, { serviceAccount: serviceAccountFile({ private_key_id: "kid-second" }) });
  assert.notEqual(rekeyed.serviceAccount, record.serviceAccount);
});

test("a Vertex key signs for Google's own token endpoint only, and the token is cached per key", async () => {
  vertex.__resetVertexTokens();
  const stored = facts.normalizeServiceAccount(serviceAccountFile());
  assert.ok(!stored.includes("attacker.example"), "the uploaded token_uri is not kept");
  const calls = [];
  let now = 1_800_000_000_000;
  const first = await vertex.vertexAccessToken(stored, { fetchImpl: tokenFetch(calls), now: () => now });
  assert.equal(first.token, "ya29.fixture-access-token");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, vertex.GOOGLE_TOKEN_URL);
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const [header, claims, signature] = form.get("assertion").split(".");
  assert.ok(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, "base64url")), "signed with the stored key");
  const parsed = JSON.parse(Buffer.from(claims, "base64url").toString());
  assert.equal(parsed.aud, vertex.GOOGLE_TOKEN_URL);
  assert.equal(parsed.iss, "runner@fixture-project-1.iam.gserviceaccount.com");
  assert.equal(parsed.scope, "https://www.googleapis.com/auth/cloud-platform");
  // Cached while enough of its life is left; minted again once it is not.
  await vertex.vertexAccessToken(stored, { fetchImpl: tokenFetch(calls), now: () => now });
  assert.equal(calls.length, 1);
  now += 56 * 60_000;
  await vertex.vertexAccessToken(stored, { fetchImpl: tokenFetch(calls), now: () => now });
  assert.equal(calls.length, 2);
  // A host run asks for a token that outlives a long turn.
  await vertex.vertexAccessToken(stored, { fetchImpl: tokenFetch(calls), now: () => now + 15 * 60_000, minRemainingMs: 50 * 60_000 });
  assert.equal(calls.length, 3);
  // A refusal names Google's reason and nothing of the key.
  vertex.__resetVertexTokens();
  const refusal = await vertex.vertexAccessToken(stored, { fetchImpl: tokenFetch([], { status: 400, body: { error: "invalid_grant", error_description: "Invalid JWT Signature." } }) }).catch((error) => error);
  assert.equal(refusal.rejected, true);
  assert.match(refusal.message, /invalid_grant/);
  assert.ok(!refusal.message.includes("PRIVATE KEY"));
  const down = await vertex.vertexAccessToken(stored, { fetchImpl: async () => { throw new TypeError("fetch failed"); } }).catch((error) => error);
  assert.equal(down.unreachable, true);
});

test("a license's credential is swapped in only on its own hosts and in the headers its provider reads", () => {
  reset();
  const rule = (kind) => relayRuleFor(facts.licenseRelaySecretName(add(kind).id));
  assert.deepEqual(rule("codex-api"), { hosts: ["api.openai.com"], headers: ["authorization"], format: ["bearer", "raw"] });
  assert.deepEqual(rule("codex-aws").hosts, ["bedrock-mantle.eu-central-1.api.aws"]);
  assert.deepEqual(rule("codex-gcp").hosts, ["aiplatform.googleapis.com"]);
  const azure = rule("codex-azure");
  assert.deepEqual(azure.hosts, ["acme.openai.azure.com"]);
  assert.ok(azure.headers.includes("api-key") && azure.headers.includes("authorization"));
  assert.deepEqual(rule("claude-aws").hosts, ["bedrock-runtime.eu-central-1.amazonaws.com"]);
  assert.deepEqual(rule("claude-gcp").hosts, ["europe-west1-aiplatform.googleapis.com"]);
  const foundry = rule("claude-azure");
  assert.deepEqual(foundry.hosts, ["acme.services.ai.azure.com"]);
  assert.ok(foundry.headers.includes("x-api-key"));
  // Those hosts — and no others — are admitted as model-API destinations for the egress proxy.
  const admitted = facts.licenseApiHosts();
  for (const host of ["bedrock-mantle.eu-central-1.api.aws", "aiplatform.googleapis.com", "acme.openai.azure.com", "europe-west1-aiplatform.googleapis.com"]) assert.ok(admitted.includes(host), host);
  assert.equal(relayRuleFor("CODEX_LICENSE_AWS_KEY:codex-aws-00000000"), null, "a removed license has no rule");
});

test("what a run is handed: the real value on the host, a placeholder in a proxied container, nothing otherwise", async () => {
  reset();
  const record = store.getLicenseRecord(add("codex-aws").id);
  assert.deepEqual(grants.containerLicenseApiCredential({ target: { backend: "host", meta: {} }, record }), { token: KEY });
  const container = (mode, channelId = "C0PROVIDER1") => ({ backend: "container", meta: { channelId }, container: { egress: { active: mode === "proxy", mode, network: mode === "proxy" ? "none" : "bridge" } } });
  const inContainer = grants.containerLicenseApiCredential({ target: container("proxy"), record });
  assert.match(inContainer.token || "", /^cgph_/, "a container holds a placeholder");
  assert.notEqual(inContainer.token, KEY);
  assert.equal(grants.lookupGrant(inContainer.token)?.secret_name ?? grants.lookupGrant(inContainer.token)?.secretName, facts.licenseRelaySecretName(record.id), "bound to this license");
  assert.match(grants.containerLicenseApiCredential({ target: container("bridge"), record }).error || "", /requires the egress proxy/);
  assert.match(grants.containerLicenseApiCredential({ target: container("proxy", ""), record }).error || "", /no channel/);
  // The value behind a Vertex placeholder is a freshly minted token, never the key file.
  const gcp = store.getLicenseRecord(add("claude-gcp").id);
  const live = await grants.licenseCredentialValue(gcp, { vertexFetch: tokenFetch() });
  assert.equal(live.value, "ya29.fixture-access-token");
  vertex.__resetVertexTokens();
  const refused = await grants.licenseCredentialValue(gcp, { vertexFetch: tokenFetch([], { status: 401, body: { error: "invalid_client" } }) });
  assert.equal(refused.value, "");
  assert.equal(refused.rejected, true);
});

test("Claude Code is started on each provider with that provider's own switches, and nothing inherited leaks in", () => {
  reset();
  const env = (kind, extra) => adapters.claudeProviderEnv(store.getLicenseRecord(add(kind, extra).id), "TOKEN", "/cfg");
  assert.deepEqual(env("claude-aws"), { CLAUDE_CONFIG_DIR: "/cfg", CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "eu-central-1", AWS_BEARER_TOKEN_BEDROCK: "TOKEN" });
  const vx = env("claude-gcp");
  assert.equal(vx.CLAUDE_CODE_USE_VERTEX, "1");
  assert.equal(vx.ANTHROPIC_VERTEX_PROJECT_ID, "fixture-project-1");
  assert.equal(vx.CLOUD_ML_REGION, "europe-west1");
  assert.equal(vx.CLAUDE_CODE_SKIP_VERTEX_AUTH, "1");
  assert.equal(vx.ANTHROPIC_VERTEX_BASE_URL, "https://europe-west1-aiplatform.googleapis.com/v1");
  assert.equal(vx.ANTHROPIC_AUTH_TOKEN, "TOKEN");
  const az = env("claude-azure");
  assert.equal(az.CLAUDE_CODE_USE_FOUNDRY, "1");
  assert.equal(az.ANTHROPIC_FOUNDRY_API_KEY, "TOKEN");
  assert.equal(az.ANTHROPIC_FOUNDRY_AUTH_TOKEN, undefined);
  assert.equal(env("claude-azure", { label: "Azure bearer", authScheme: "bearer" }).ANTHROPIC_FOUNDRY_AUTH_TOKEN, "TOKEN");
  // A server that is not Anthropic's serves only the ids its license lists, so every alias Claude
  // Code resolves on its own (the small model, a subagent's "sonnet") is pinned to a listed model:
  // the one carrying the alias in its id, else the turn's own model, else the first listed.
  const pin = (models) => ({ ANTHROPIC_DEFAULT_OPUS_MODEL: models[0], ANTHROPIC_DEFAULT_SONNET_MODEL: models[1], ANTHROPIC_DEFAULT_HAIKU_MODEL: models[2] });
  assert.deepEqual(env("claude-api"), {
    CLAUDE_CONFIG_DIR: "/cfg", ANTHROPIC_BASE_URL: "https://llm.example.com", ANTHROPIC_AUTH_TOKEN: "TOKEN", ...pin(["team-large", "team-large", "team-large"]),
  });
  const mixed = store.getLicenseRecord(add("claude-api", { label: "Claude mixed", models: ["team-large", "team-haiku-fast", "team-small"] }).id);
  assert.deepEqual(
    Object.fromEntries(Object.entries(adapters.claudeProviderEnv(mixed, "TOKEN", "/cfg", "team-small")).filter(([name]) => name.startsWith("ANTHROPIC_DEFAULT_"))),
    pin(["team-small", "team-small", "team-haiku-fast"]),
  );
  // Anthropic's own API knows its own aliases: nothing is pinned there.
  const vendorEnv = adapters.claudeProviderEnv(store.getLicenseRecord(add("claude-api", { label: "Anthropic API", baseUrl: "https://api.anthropic.com", models: [] }).id), "TOKEN", "/cfg");
  assert.deepEqual(Object.keys(vendorEnv).filter((name) => name.startsWith("ANTHROPIC_DEFAULT_")), []);
  // The daemon's own cloud settings, or a channel's, cannot redirect a cloud route.
  const inherited = {
    PATH: "/usr/bin", HOME: "/home/x", ANTHROPIC_API_KEY: "inherited", ANTHROPIC_BASE_URL: "https://elsewhere.example", AWS_PROFILE: "ops",
    AWS_ACCESS_KEY_ID: "inherited", CLAUDE_CODE_USE_BEDROCK: "1", CLOUD_ML_REGION: "us-east5", GOOGLE_APPLICATION_CREDENTIALS: "/etc/key.json",
  };
  const built = buildClaudeEnv({ home: "/home/x", providerEnv: vx }, inherited);
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "CLAUDE_CODE_USE_BEDROCK", "GOOGLE_APPLICATION_CREDENTIALS"]) assert.equal(built[name], undefined, name);
  assert.equal(built.CLOUD_ML_REGION, "europe-west1");
  assert.equal(built.CLAUDE_CODE_USE_VERTEX, "1");
});

test("Codex is pointed at each provider through config overrides, with the credential in the environment only", () => {
  reset();
  const routing = (kind, extra) => adapters.codexProviderRouting(store.getLicenseRecord(add(kind, extra).id), "TOKEN");
  const api = routing("codex-api");
  assert.ok(api.config.includes('model_providers.cgapi.base_url="https://api.openai.com/v1"'));
  assert.ok(api.config.includes('model_providers.cgapi.wire_api="responses"'));
  assert.ok(api.config.includes('model_providers.cgapi.env_key="CG_LICENSE_KEY"'));
  assert.deepEqual(api.env, { CG_LICENSE_KEY: "TOKEN" });
  const aws = routing("codex-aws");
  assert.deepEqual(aws.config, ['model_provider="amazon-bedrock"', 'model_providers.amazon-bedrock.aws.region="eu-central-1"']);
  assert.deepEqual(aws.env, { AWS_BEARER_TOKEN_BEDROCK: "TOKEN", AWS_REGION: "eu-central-1" });
  const gcp = routing("codex-gcp");
  assert.ok(gcp.config.includes('model_provider="gcp"'));
  assert.ok(gcp.config.includes('model_providers.gcp.project_id="fixture-project-1"'));
  assert.ok(gcp.config.includes('model_providers.gcp.location="global"'));
  assert.ok(gcp.config.includes('model_providers.gcp.auth={command="printenv",args=["CG_LICENSE_KEY"]}'));
  const azure = routing("codex-azure");
  assert.ok(azure.config.includes('model_providers.cgazure.env_http_headers={"api-key"="CG_LICENSE_KEY"}'));
  assert.ok(azure.config.includes('model_providers.cgazure.query_params={"api-version"="2025-04-01-preview"}'));
  assert.ok(azure.config.includes('model_providers.cgazure.base_url="https://acme.openai.azure.com/openai/v1"'));
  for (const route of [api, aws, gcp, azure]) assert.ok(!route.config.join(" ").includes("TOKEN"), "the credential never rides the command line");

  const target = createFakeRuntime().target();
  const args = buildCodexArgs({ prompt: "hi", sessionId: "t", isNewSession: true, cwd: target.cwd, outFile: `${target.artifactDir}/tmp/out.txt`, target, provider: { ...azure, home: "/lic" } });
  assert.ok(azure.config.every((entry) => args.includes(entry)));
  assert.ok(!args.join(" ").includes("TOKEN"));
  // The daemon's own OpenAI or cloud settings do not follow a provider run.
  const inherited = { PATH: "/usr/bin", HOME: "/home/x", OPENAI_API_KEY: "inherited", OPENAI_BASE_URL: "https://elsewhere.example", CODEX_API_KEY: "inherited", AWS_PROFILE: "ops", AWS_ACCESS_KEY_ID: "inherited" };
  const built = buildCodexEnv({ target: { backend: "host", meta: {} }, provider: { ...aws, home: "/lic" } }, inherited);
  for (const name of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "AWS_PROFILE", "AWS_ACCESS_KEY_ID"]) assert.equal(built[name], undefined, name);
  assert.equal(built.AWS_BEARER_TOKEN_BEDROCK, "TOKEN");
  assert.equal(built.AWS_REGION, "eu-central-1");
  assert.equal(built.CODEX_HOME, "/lic", "a provider run keeps its sessions apart from the operator's login");
});

test("verification asks each provider's own server, with the header that provider reads", async () => {
  reset();
  const probe = async (kind, extra, reply = { status: 200, body: '{"data":[{"id":"a"},{"id":"b"}]}' }) => {
    const record = add(kind, extra);
    const calls = [];
    const result = await store.verifyLicense(record.id, { fetchImpl: async (url, init) => {
      calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers || {})) });
      return new Response(reply.body, { status: reply.status, headers: { "content-type": "application/json" } });
    } });
    return { record, calls, result };
  };
  const azure = await probe("codex-azure");
  assert.equal(azure.calls[0].url, "https://acme.openai.azure.com/openai/v1/models?api-version=2025-04-01-preview");
  assert.equal(azure.calls[0].headers["api-key"], KEY);
  assert.equal(azure.calls[0].headers.authorization, undefined);
  assert.equal(azure.result.verification.ok, true);
  assert.match(azure.result.verification.detail, /lists 2 models/);

  const mantle = await probe("codex-aws", {}, { status: 404, body: "{}" });
  assert.equal(new URL(mantle.calls[0].url).hostname, "bedrock-mantle.eu-central-1.api.aws");
  assert.equal(mantle.calls[0].headers.authorization, `Bearer ${KEY}`);
  assert.equal(mantle.result.verification.ok, true, "no model list is not a rejection");
  assert.equal(mantle.result.verification.verified, false);
  assert.match(mantle.result.verification.detail, /verified by the first turn/);

  const bedrock = await probe("claude-aws", {}, { status: 403, body: '{"message":"User is not authorized to perform: bedrock:ListFoundationModels"}' });
  assert.equal(new URL(bedrock.calls[0].url).hostname, "bedrock.eu-central-1.amazonaws.com");
  assert.equal(bedrock.result.verification.ok, true, "a key that may not LIST models may still invoke them");
  assert.equal(bedrock.result.verification.verified, false);

  const foundry = await probe("claude-azure", {}, { status: 401, body: '{"error":"bad key"}' });
  assert.equal(new URL(foundry.calls[0].url).hostname, "acme.services.ai.azure.com");
  assert.equal(foundry.calls[0].headers["x-api-key"], KEY);
  assert.equal(foundry.result.verification.ok, false);
  assert.equal(foundry.result.status.ready, false, "a rejected key is not offered to a turn");
  assert.equal((await registry.requireAdapter(foundry.record.id).selectionReadiness()).ready, false);

  // Vertex: the key file is proved against Google's token endpoint, and that is the only request.
  const gcpCalls = [];
  const gcp = add("claude-gcp");
  const verdict = await store.verifyLicense(gcp.id, { fetchImpl: tokenFetch(gcpCalls) });
  assert.deepEqual(gcpCalls.map((call) => call.url), [vertex.GOOGLE_TOKEN_URL]);
  assert.equal(verdict.verification.ok, true);
  assert.match(verdict.verification.detail, /Google accepted the service-account key/);
  for (const result of [azure.result, mantle.result, bedrock.result, foundry.result, verdict]) {
    const text = JSON.stringify(result);
    assert.ok(!text.includes(KEY) && !text.includes("PRIVATE KEY") && !text.includes("ya29."));
  }
});

test("removing a provider license forgets its credential, its token and its rule", async () => {
  reset();
  const record = add("codex-gcp");
  const calls = [];
  await grants.licenseCredentialValue(store.getLicenseRecord(record.id), { vertexFetch: tokenFetch(calls) });
  assert.equal(calls.length, 1);
  await store.deleteLicense(record.id);
  assert.equal(registry.isEngineId(record.id), false);
  assert.equal(relayRuleFor(facts.licenseRelaySecretName(record.id)), null);
  // The same key added again is asked for afresh — the old token did not outlive the license.
  const again = add("codex-gcp", { label: "Vertex again" });
  await grants.licenseCredentialValue(store.getLicenseRecord(again.id), { vertexFetch: tokenFetch(calls) });
  assert.equal(calls.length, 2);
});

// ── The run itself ──────────────────────────────────────────────────────────────────────────────
const claudeChild = (calls, text = "hello") => (spawnTarget, spec) => {
  calls.push({ ...spec, spawnTarget });
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  queueMicrotask(() => {
    child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", session_id: "provider-session", result: text, total_cost_usd: 9, usage: { input_tokens: 4, output_tokens: 2 } })}\n`);
    child.emit("close", 0);
  });
  return child;
};

test("a Vertex turn in a container holds a placeholder: not the key file, not the minted token", async () => {
  reset();
  const record = store.getLicenseRecord(add("claude-gcp").id);
  // The token the daemon holds for this key (the run mints it before the turn starts).
  await vertex.vertexAccessToken(record.serviceAccount, { fetchImpl: tokenFetch() });
  const calls = [];
  const target = {
    backend: "container", cwd: "/work", meta: { channelId: "C_VERTEX_RUN" },
    container: { home: "/home/agent", egress: { active: true, mode: "proxy" } },
    runtime: { capabilities: { isolated: true }, spawn: claudeChild(calls) },
  };
  const adapter = registry.requireAdapter(record.id);
  const result = await adapter.run({ cwd: "/work", prompt: "hi", session: { id: "provider-session", fresh: true }, target, runtime: { pluginRuntime: null, settingsFile: "/lockdown.json" } });
  assert.equal(result.content, "hello");
  assert.equal(result.costUSD ?? null, null, "Claude Code's price table is not this provider's bill");
  const spec = calls[0];
  assert.equal(spec.env.CLAUDE_CODE_USE_VERTEX, "1");
  assert.equal(spec.env.ANTHROPIC_VERTEX_PROJECT_ID, "fixture-project-1");
  assert.equal(spec.env.ANTHROPIC_VERTEX_BASE_URL, "https://europe-west1-aiplatform.googleapis.com/v1");
  assert.match(spec.env.ANTHROPIC_AUTH_TOKEN, /cgph_/);
  assert.equal(spec.env.CLAUDE_CODE_OAUTH_TOKEN, undefined, "the gateway's Claude login is not sent to another provider");
  const text = JSON.stringify({ args: spec.args, env: spec.env });
  assert.ok(!text.includes("ya29.") && !text.includes("PRIVATE KEY"));
  assert.equal(spec.args[spec.args.indexOf("--settings") + 1], "/lockdown.json", "the channel's lockdown still applies");
  assert.equal(spec.args.includes("--model"), false, "with no list and no chosen model, the CLI's own default answers — not the catalog's first (most expensive) entry");
  assert.equal(target.container.claudeConfigDir, undefined, "the shared target is not mutated");
});

test("a provider turn outside the egress proxy is refused, and a host turn scrubs the real key from its output", async () => {
  reset();
  const record = store.getLicenseRecord(add("claude-aws").id);
  const adapter = registry.requireAdapter(record.id);
  const ctx = (target) => ({ cwd: "/work", prompt: "hi", session: { id: "provider-session", fresh: true }, target, runtime: { pluginRuntime: null } });
  const bridge = { backend: "container", cwd: "/work", meta: { channelId: "C_BRIDGE" }, container: { home: "/home/agent", egress: { active: false, mode: "bridge" } }, runtime: { capabilities: { isolated: true }, spawn() { throw new Error("must not spawn"); } } };
  await assert.rejects(() => adapter.run(ctx(bridge)), /requires the egress proxy/);
  const calls = [];
  const host = { backend: "host", cwd: "/work", meta: {}, runtime: { capabilities: { isolated: false }, spawn: claudeChild(calls, `the key is ${KEY}`) } };
  const result = await adapter.run(ctx(host));
  assert.equal(calls[0].env.AWS_BEARER_TOKEN_BEDROCK, KEY, "only an admin's direct-host turn holds the real key");
  assert.equal(calls[0].env.AWS_REGION, "eu-central-1");
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test("a Codex provider turn gets its routing, its own session directory and a placeholder", async () => {
  reset();
  const record = store.getLicenseRecord(add("codex-azure").id);
  let seen = null;
  const written = [];
  const [adapter] = adapters.buildLicenseAdapters({ codex: { ...registry.requireAdapter("codex"), run: async (ctx) => { seen = ctx; return { content: `echo ${KEY}` }; } } }, [record]);
  const target = {
    backend: "container", cwd: "/work", meta: { channelId: "C_AZURE_RUN", engine: "codex" },
    container: { home: "/home/agent", codexHome: "/home/agent/.codex", egress: { active: true, mode: "proxy" } },
    runtime: { capabilities: { isolated: true }, spawn() { throw new Error("the stubbed harness spawns nothing"); }, writeHomeFile: async (_target, file) => { written.push(file); } },
  };
  const result = await adapter.run({ cwd: "/work", prompt: "hi", target, session: { id: "s", fresh: true }, runtime: { managedMcpServers: [] } });
  assert.equal(seen.target.meta.engine, record.id);
  assert.notEqual(seen.target.container.codexHome, "/home/agent/.codex", "not the shared Codex login's directory");
  assert.equal(target.container.codexHome, "/home/agent/.codex", "the shared target is not mutated");
  assert.equal(written.length, 1);
  assert.ok(written[0].file.startsWith(`${seen.target.container.codexHome}/`));
  assert.equal(seen.runtime.model, "gpt-deploy", "an unset model is the first deployment listed");
  const provider = seen.runtime.codexProvider;
  assert.match(provider.env.CG_LICENSE_KEY, /cgph_/);
  assert.ok(provider.config.includes('model_providers.cgazure.base_url="https://acme.openai.azure.com/openai/v1"'));
  assert.ok(!JSON.stringify(seen.runtime).includes(KEY));
  assert.ok(!JSON.stringify(result).includes(KEY), "a key the model echoed never reaches the reply");
});

test("a Codex license on another provider records tokens in Codex's shape and no OpenAI-priced cost", async () => {
  reset();
  const { normalizeUsage } = await import("../src/gateway/usage.js");
  const { saveSettings } = await import("../src/config/settings.js");
  saveSettings({ codexRatePer1MTokens: 10 });
  const usage = { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 };
  const azure = add("codex-azure");
  const onAzure = normalizeUsage({ engine: azure.id, model: "gpt-deploy", usage });
  assert.equal(onAzure.costUSD, null, "an Azure deployment is not billed at OpenAI's rates");
  assert.equal(onAzure.estimated, false);
  assert.equal(onAzure.cachedTok, 400, "cached input is read the way Codex reports it");
  assert.deepEqual([onAzure.inTok, onAzure.outTok], [normalizeUsage({ engine: "codex", usage }).inTok, 50]);
  const openai = add("codex-api", { baseUrl: "https://api.openai.com/v1", models: [] });
  assert.equal(normalizeUsage({ engine: openai.id, model: "", usage }).estimated, true, "OpenAI's own API keeps the Codex estimate");
});
