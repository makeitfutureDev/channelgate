// The Activity view's "Admin & security events" table. An audit row nobody can read is not an
// audit trail: GET /api/audit/events existed for a long time with nothing in the admin UI rendering
// it, so every channel-policy change and secret-reveal refusal was recorded and invisible.
// public/admin-events.js holds the wording (no DOM, no fetch) so it can be checked here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const { EVENT_LABELS, describeEvent, eventLabel, eventValue, isAdminEvent } = await import("../public/admin-events.js");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

test("the Activity view carries the events table and loads it", () => {
  assert.match(html, /id="audit-events"/);
  assert.match(html, /Admin &amp; security events/);
  assert.match(app, /\/api\/audit\/events\?limit=/);
  assert.match(app, /loadAuditEvents\(\)/);
});

test("a channel policy change reads as key: before → after", () => {
  const line = describeEvent({
    event: "channel_meta_changed",
    slug: "acme",
    actor: "admin-ui",
    keys: ["allowNetwork", "adminMode", "workDir"],
    changes: {
      allowNetwork: { from: true, to: false },
      adminMode: { from: false, to: true },
      workDir: { from: "", to: "/home/agent/Code/acme" },
    },
  });
  assert.equal(line, "allowNetwork: on → off · adminMode: off → on · workDir: — → /home/agent/Code/acme");
});

test("a truncated list change still says what happened", () => {
  assert.equal(
    describeEvent({ event: "channel_meta_changed", changes: { allowedUsers: { fromCount: 3, toCount: 412, truncated: true } } }),
    "allowedUsers: 3 → 412 entries",
  );
});

test("other kinds fall back to their own fields, minus the ones with their own column", () => {
  assert.equal(
    describeEvent({ ts: "2026-09-06T10:00:00.000Z", event: "secret_reveal_rejected", scope: "settings", field: "adminPassword", id: "", actor: "admin-ui", reason: '"adminPassword" is not revealable' }),
    'scope: settings · field: adminPassword · id: — · reason: "adminPassword" is not revealable',
  );
  assert.equal(describeEvent({ event: "skill_granted", slug: "acme", author: "U1", skills: ["deploy", "review"] }), "skills: deploy, review");
});

test("an unknown kind is still readable, and still renders", () => {
  assert.equal(eventLabel("channel_meta_changed"), "Channel settings changed");
  assert.equal(eventLabel("some_future_event"), "some future event", "a new kind must not render blank");
  assert.equal(isAdminEvent({ event: "some_future_event" }), false, 'it is simply not in the default "admin & security" slice');
  assert.equal(isAdminEvent({ event: "channel_meta_changed" }), true);
  // Prototype keys must not masquerade as labelled kinds.
  assert.equal(isAdminEvent({ event: "constructor" }), false);
  assert.equal(eventLabel("constructor"), "constructor");
});

test("the two gaps this view exists for both have a label", () => {
  assert.ok(EVENT_LABELS.channel_meta_changed);
  assert.ok(EVENT_LABELS.secret_reveal_rejected);
  assert.notEqual(EVENT_LABELS.secret_reveal_rejected, EVENT_LABELS.secret_reveal_denied, "a refused field and a wrong password are different events");
});

test("empty and structured values render without leaking JSON noise", () => {
  assert.equal(eventValue(""), "—");
  assert.equal(eventValue(null), "—");
  assert.equal(eventValue([]), "(none)");
  assert.equal(eventValue(false), "off");
  assert.equal(eventValue(0), "0");
});
