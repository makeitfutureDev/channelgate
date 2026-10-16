import test from "node:test";
import assert from "node:assert/strict";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();

const { handleSettingsFormSubmission, saveSettingsForm } = await import("../src/slack/app.js");
const { buildChannelSettingsView, parseSettingsMetadata } = await import("../src/slack/channel-settings.js");
const store = await import("../src/config/store.js");
const entry = await store.upsertChannelEntry("C_SECRET_RESET", { name: "secret-reset", type: "channel", isDM: false });
await store.saveChannelMeta(entry.slug, store.defaultChannelMeta({ channelId: "C_SECRET_RESET", name: "secret-reset", type: "channel", isDM: false }));
await store.setUser("U_EDITOR", { name: "Editor", approved: true });
const context = async () => ({ entry, meta: await store.getChannelMeta(entry.slug), clicker: "U_EDITOR", userIsAdmin: true, userIsApproved: true });

// Slack retains user input by block_id + action_id when views.update reopens a form. Keeping
// an input's initial_value out of the payload alone does not reset the native control.
function modal(form, snapshot = {}) {
  const state = { channelId: "C_SECRET_RESET", slug: entry.slug, ownerId: "U_EDITOR", tab: form.endsWith(":p") || form.includes(":p:") ? "you" : "mcp", form };
  const rootView = async (_entry, _meta, nextState) => buildChannelSettingsView(snapshot, nextState, { tab: nextState.tab, canManageCustomMcp: true });
  const retained = new Map();
  let view;
  const identity = (block) => `${block.block_id}:${block.element.action_id}`;
  const input = (field) => view.blocks.find((block) => block.block_id?.startsWith(`cgf_${field}_`));
  function render(next) {
    view = next;
    for (const block of view.blocks.filter((b) => b.type === "input")) {
      if (!retained.has(identity(block))) retained.set(identity(block), block.element.type === "checkboxes"
        ? { selected_options: block.element.initial_options || [] }
        : { value: block.element.initial_value || "" });
    }
  }
  render(buildChannelSettingsView(snapshot, state, { tab: state.tab, canManageCustomMcp: true }));
  return {
    input,
    value: (field) => retained.get(identity(input(field))).value,
    type: (field, value) => retained.set(identity(input(field)), { value }),
    view: () => view,
    async submit(save, extraValues = {}) {
      const values = Object.fromEntries(view.blocks.filter((b) => b.type === "input").map((b) => [b.block_id, { [b.element.action_id]: retained.get(identity(b)) }]));
      const acks = [];
      await handleSettingsFormSubmission({
        body: { user: { id: "U_EDITOR" } },
        view: { ...view, id: "V_RESET", state: { values: { ...extraValues, ...values } } },
        ack: async (response) => { acks.push(response); if (response?.view) render(response.view); },
        client: { views: { update: async ({ view: next }) => render(next) } },
      }, { context, rootView, save });
      return acks;
    },
  };
}

for (const scope of ["c", "p"]) {
  test(`async custom MCP refusal clears native token retention on every retry (${scope})`, async () => {
    const ui = modal(`cm-add:${scope}`);
    ui.type("name", "example");
    ui.type("url", "https://mcp.example.com/mcp");
    const nameId = ui.input("name").block_id;
    const urlId = ui.input("url").block_id;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = `dummy-rejected-token-${attempt}`;
      ui.type("token", token);
      const tokenId = ui.input("token").block_id;
      await ui.submit(async (_key, values) => {
        assert.equal(values.token, token, "retry reads the current native token input");
        return { field: "url", error: "URL resolved to a loopback address." };
      });
      assert.equal(ui.value("token"), "", "Slack must not retain the refused token");
      assert.notEqual(ui.input("token").block_id, tokenId);
      assert.equal(ui.input("name").block_id, nameId);
      assert.equal(ui.input("url").block_id, urlId);
      assert.equal(ui.value("name"), "example");
      assert.equal(ui.value("url"), "https://mcp.example.com/mcp");
      assert.match(JSON.stringify(ui.view()), /loopback/);
      assert.equal(JSON.stringify(ui.view()).includes(token), false, "neither blocks nor metadata contain the token");
      assert.equal(parseSettingsMetadata(ui.view().private_metadata).form, `cm-add:${scope}`);
    }
    ui.type("token", "dummy-corrected-token");
    await ui.submit(async (_key, values) => {
      assert.equal(values.token, "dummy-corrected-token");
      return { notice: "Saved" };
    });
    assert.equal(parseSettingsMetadata(ui.view().private_metadata).form, "");
  });

  test(`blank custom MCP edit after an async refusal keeps the stored token (${scope})`, async () => {
    const name = `existing-${scope}`;
    const original = "dummy-saved-token";
    await saveSettingsForm(`cm-add:${scope}`, { name, url: "https://93.184.215.14/mcp", token: original }, await context());
    const ui = modal(`cm:${scope}:${name}`, { customMcps: { [scope === "c" ? "channel" : "personal"]: [{ name, serverName: name, url: "https://93.184.215.14/mcp" }] } });
    ui.type("token", "dummy-rejected-replacement");
    const staleId = ui.input("token").block_id;
    await ui.submit(async () => ({ field: "url", error: "URL resolved to a loopback address." }));
    assert.equal(ui.value("token"), "");
    ui.type("url", "https://93.184.215.14/v2");
    await ui.submit(async (key, values, ctx) => {
      assert.equal(values.token, "", "a stale input identity cannot supply the replacement");
      return saveSettingsForm(key, values, ctx);
    }, { [staleId]: { v: { value: "dummy-rejected-replacement" } } });
    const saved = scope === "c" ? await store.getChannelMeta(entry.slug) : await store.getUser("U_EDITOR");
    assert.equal(saved.customMcps.find((row) => row.name === name).token, original);
    assert.equal(saved.customMcps.find((row) => row.name === name).url, "https://93.184.215.14/v2");
    assert.equal(parseSettingsMetadata(ui.view().private_metadata).form, "");
  });
}

test("local token validation after an async refusal targets the new visible input", async () => {
  const ui = modal("cm-add:p");
  ui.type("name", "example");
  ui.type("url", "https://mcp.example.com/mcp");
  ui.type("token", "dummy-rejected-token");
  await ui.submit(async () => ({ field: "url", error: "Address refused." }));
  ui.type("token", "short");
  const visibleId = ui.input("token").block_id;
  const acks = await ui.submit(async () => assert.fail("local validation must prevent saving"));
  assert.equal(acks[0].response_action, "errors");
  assert.deepEqual(Object.keys(acks[0].errors), [visibleId]);
  assert.match(acks[0].errors[visibleId], /valid token/);
});

test("a duplicate variable refusal clears the native value but retains non-secret fields", async () => {
  const ui = modal("var-add:p", { personalSecrets: [] });
  ui.type("name", "EXISTING_KEY");
  ui.type("hosts", "api.example.com");
  ui.type("value", "dummy-rejected-value");
  await ui.submit(async () => ({ field: "name", error: "EXISTING_KEY already exists." }));
  assert.equal(ui.value("value"), "");
  assert.equal(ui.value("name"), "EXISTING_KEY");
  assert.equal(ui.value("hosts"), "api.example.com");
  assert.equal(JSON.stringify(ui.view()).includes("dummy-rejected-value"), false);
});
