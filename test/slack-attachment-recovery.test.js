import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { shapeMessages } from "../src/slack/read.js";

const moduleUrl = new URL("../src/slack/attachments.js", import.meta.url);

async function attachmentModule() {
  assert.equal(
    existsSync(fileURLToPath(moduleUrl)),
    true,
    "src/slack/attachments.js must provide canonical Slack attachment recovery",
  );
  return import(moduleUrl.href);
}

test("collectSlackFiles finds and deduplicates direct, legacy, attachment, and block references", async () => {
  const { collectSlackFiles } = await attachmentModule();
  const direct = {
    id: "F1",
    name: "catalog.xlsx",
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 1200,
    url_private_download: "https://files.slack.test/F1/download",
  };

  const files = collectSlackFiles({
    files: [direct],
    file: { id: "F2", name: "legacy.pdf" },
    x_files: ["F3"],
    attachments: [
      { file_id: "F4" },
      { files: [{ id: "F1", name: "less-complete.xlsx" }] },
    ],
    blocks: [{ type: "file", file_id: "F5" }],
  });

  assert.deepEqual(files.map((file) => file.id), ["F1", "F2", "F3", "F4", "F5"]);
  assert.equal(files[0].name, "catalog.xlsx");
  assert.equal(files[0].url_private_download, direct.url_private_download);
});

test("claimSlackMessageTrigger deduplicates message and app_mention envelopes by channel and ts", async () => {
  const { claimSlackMessageTrigger } = await attachmentModule();
  const keys = new Set();
  const seen = { add: (key) => keys.has(key) ? false : (keys.add(key), true) };

  assert.equal(claimSlackMessageTrigger(seen, { type: "app_mention", channel: "C1", ts: "99.1" }), true);
  assert.equal(claimSlackMessageTrigger(seen, { type: "message", channel: "C1", ts: "99.1" }), false);
  assert.equal(claimSlackMessageTrigger(seen, { type: "message", channel: "C1", ts: "99.2" }), true);
});

test("hydrateSlackMessage fetches an exact canonical root when app_mention omits files", async () => {
  const { hydrateSlackMessage } = await attachmentModule();
  const calls = [];
  const file = {
    id: "FXLSX",
    name: "Bruckner_bez_duplicit.xlsx",
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 33_000,
    url_private_download: "https://files.slack.test/FXLSX/download",
  };
  const client = {
    conversations: {
      history: async (args) => {
        calls.push(args);
        return { messages: [{ ts: "1784895598.112879", user: "U1", text: "<@B1> do you see this file?", files: [file] }] };
      },
    },
    files: { info: async () => assert.fail("complete files must not call files.info") },
  };

  const hydrated = await hydrateSlackMessage({
    type: "app_mention",
    channel: "C1",
    channel_type: "channel",
    user: "U1",
    text: "<@B1> do you see this file?",
    ts: "1784895598.112879",
  }, client);

  assert.deepEqual(calls, [{
    channel: "C1",
    oldest: "1784895598.112879",
    latest: "1784895598.112879",
    inclusive: true,
    limit: 1,
  }]);
  assert.equal(hydrated.channel_type, "channel");
  assert.equal(hydrated.files[0].name, "Bruckner_bez_duplicit.xlsx");
});

test("hydrateSlackMessage briefly retries an empty app_mention canonical message for file races", async () => {
  const { hydrateSlackMessage } = await attachmentModule();
  let calls = 0;
  let sleeps = 0;
  const client = {
    conversations: {
      history: async () => {
        calls++;
        return {
          messages: [{
            ts: "1784895598.112879",
            user: "U1",
            text: "<@B1> do you see this file?",
            ...(calls === 1 ? {} : {
              files: [{
                id: "FLATE",
                name: "late.xlsx",
                mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                size: 512,
                url_private_download: "https://files.slack.test/FLATE/download",
              }],
            }),
          }],
        };
      },
    },
    files: { info: async () => assert.fail("the recovered file is complete") },
  };

  const hydrated = await hydrateSlackMessage({
    type: "app_mention",
    channel: "C1",
    channel_type: "channel",
    user: "U1",
    text: "<@B1> do you see this file?",
    ts: "1784895598.112879",
  }, client, {
    retryDelayMs: 1,
    sleep: async () => { sleeps++; },
  });

  assert.equal(calls, 2);
  assert.equal(sleeps, 1);
  assert.equal(hydrated.files[0].id, "FLATE");
});

test("hydrateSlackMessage resolves and retries a pending threaded file reference", async () => {
  const { hydrateSlackMessage } = await attachmentModule();
  let replyCalls = 0;
  let infoCalls = 0;
  let sleeps = 0;
  const client = {
    conversations: {
      replies: async (args) => {
        replyCalls++;
        assert.equal(args.channel, "C1");
        assert.equal(args.ts, "100.1");
        assert.equal(args.oldest, "101.2");
        assert.equal(args.latest, "101.2");
        assert.equal(args.inclusive, true);
        return { messages: [{ ts: "101.2", user: "U1", text: "<@B1> review", x_files: ["FPDF"] }] };
      },
    },
    files: {
      info: async ({ file }) => {
        infoCalls++;
        assert.equal(file, "FPDF");
        if (infoCalls === 1) return { file: { id: "FPDF", file_access: "check_file_info" } };
        return {
          file: {
            id: "FPDF",
            name: "brief.pdf",
            mimetype: "application/pdf",
            size: 2048,
            url_private_download: "https://files.slack.test/FPDF/download",
          },
        };
      },
    },
  };

  const hydrated = await hydrateSlackMessage({
    type: "app_mention",
    channel: "C1",
    channel_type: "channel",
    user: "U1",
    text: "<@B1> review",
    ts: "101.2",
    thread_ts: "100.1",
  }, client, {
    retryDelayMs: 1,
    sleep: async () => { sleeps++; },
  });

  assert.equal(replyCalls, 2);
  assert.equal(infoCalls, 2);
  assert.equal(sleeps, 1);
  assert.equal(hydrated.files[0].name, "brief.pdf");
  assert.equal(hydrated.files[0].url_private_download, "https://files.slack.test/FPDF/download");
});

test("hydrateSlackMessage recovers the nearest earlier thread file when the mention follows it", async () => {
  const { hydrateSlackMessage } = await attachmentModule();
  let calls = 0;
  const earlier = {
    id: "FROOT",
    name: "price-list.xlsx",
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 8192,
    url_private_download: "https://files.slack.test/FROOT/download",
  };
  const client = {
    conversations: {
      replies: async (args) => {
        calls++;
        if (calls === 1) {
          assert.equal(args.oldest, "101.2");
          return { messages: [{ ts: "101.2", user: "U1", text: "<@B1> process the file" }] };
        }
        assert.equal(args.latest, "101.2");
        assert.equal(args.inclusive, true);
        assert.equal(args.limit, 200);
        return {
          messages: [
            { ts: "100.1", user: "U1", text: "", files: [earlier] },
            { ts: "101.2", user: "U1", text: "<@B1> process the file" },
          ],
        };
      },
    },
    files: { info: async () => assert.fail("the earlier file is already complete") },
  };

  const hydrated = await hydrateSlackMessage({
    type: "app_mention",
    channel: "C1",
    channel_type: "channel",
    user: "U1",
    text: "<@B1> process the file",
    ts: "101.2",
    thread_ts: "100.1",
  }, client);

  assert.equal(calls, 2);
  assert.equal(hydrated.files[0].id, "FROOT");
  assert.equal(hydrated.files[0].name, "price-list.xlsx");
});

test("hydrateSlackMessage carries only the thread ROOT's file past intervening text, marked as a retry", async () => {
  const { hydrateSlackMessage } = await attachmentModule();
  const client = {
    conversations: {
      replies: async (args) => {
        if (args.oldest) {
          return { messages: [{ ts: "104.1", user: "U1", text: "<@B1> try again" }] };
        }
        return {
          messages: [
            {
              ts: "100.1",
              user: "U1",
              text: "<@B1> improve this",
              files: [{
                id: "FROOTVID",
                name: "recording.mp4",
                size: 253445073,
                url_private_download: "https://files.slack.test/FROOTVID/download",
              }],
            },
            {
              ts: "101.1",
              user: "U2",
              text: "",
              files: [{ id: "FMID", name: "mid.xlsx", url_private_download: "https://files.slack.test/FMID/download" }],
            },
            { ts: "102.1", user: "U2", text: "unrelated follow-up" },
            { ts: "104.1", user: "U1", text: "<@B1> try again" },
          ],
        };
      },
    },
  };

  const hydrated = await hydrateSlackMessage({
    type: "app_mention",
    channel: "C1",
    channel_type: "channel",
    user: "U1",
    text: "<@B1> try again",
    ts: "104.1",
    thread_ts: "100.1",
  }, client, {
    maxAttempts: 1,
  });

  // The root's recording is the thread's subject and comes along as a RETRY (the pipeline skips it
  // once its bytes are on disk); the mid-thread file behind intervening text is still not reached.
  assert.equal(hydrated.files.length, 1);
  assert.equal(hydrated.files[0].id, "FROOTVID");
  assert.equal(hydrated.files[0].carriedFrom, "root");
  assert.equal(hydrated.files[0].size, 253445073);
});

test("hydrateSlackMessage leaves a reply alone when the thread root has no file either", async () => {
  const { hydrateSlackMessage } = await attachmentModule();
  const client = {
    conversations: {
      replies: async (args) => {
        if (args.oldest) return { messages: [{ ts: "103.1", user: "U1", text: "<@B1> summarize" }] };
        return {
          messages: [
            { ts: "100.1", user: "U1", text: "kickoff notes" },
            { ts: "101.1", user: "U2", text: "", files: [{ id: "FOLD", name: "old.xlsx", url_private_download: "https://files.slack.test/FOLD/download" }] },
            { ts: "102.1", user: "U2", text: "unrelated follow-up" },
            { ts: "103.1", user: "U1", text: "<@B1> summarize" },
          ],
        };
      },
    },
  };
  const hydrated = await hydrateSlackMessage({
    type: "app_mention", channel: "C1", channel_type: "channel", user: "U1", text: "<@B1> summarize", ts: "103.1", thread_ts: "100.1",
  }, client, { maxAttempts: 1 });
  assert.deepEqual(hydrated.files, []);
});

test("hydrateSlackMessage degrades to complete event files when canonical lookup fails", async () => {
  const { hydrateSlackMessage } = await attachmentModule();
  const warnings = [];
  const eventFile = {
    id: "FIMG",
    name: "screen.png",
    mimetype: "image/png",
    size: 4096,
    url_private_download: "https://files.slack.test/FIMG/download",
  };
  const hydrated = await hydrateSlackMessage({
    type: "message",
    channel: "C1",
    channel_type: "channel",
    user: "U1",
    text: "<@B1> inspect",
    ts: "200.1",
    files: [eventFile],
  }, {
    conversations: { history: async () => { throw new Error("ratelimited"); } },
    files: { info: async () => assert.fail("complete event file must survive without resolution") },
  }, {
    logger: { warn: (message) => warnings.push(message) },
  });

  assert.equal(hydrated.files[0].name, "screen.png");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /canonical Slack message lookup failed/);
});

test("hydrateSlackMessage does not retry an ordinary text-only canonical message", async () => {
  const { hydrateSlackMessage } = await attachmentModule();
  let calls = 0;
  let sleeps = 0;
  const event = {
    type: "message",
    channel: "C1",
    channel_type: "channel",
    user: "U1",
    text: "<@B1> hello",
    ts: "300.1",
  };
  const hydrated = await hydrateSlackMessage(event, {
    conversations: {
      history: async () => {
        calls++;
        return { messages: [{ ts: "300.1", user: "U1", text: "<@B1> hello" }] };
      },
    },
    files: { info: async () => assert.fail("text messages have no file lookup") },
  }, {
    sleep: async () => { sleeps++; },
  });

  assert.equal(calls, 1);
  assert.equal(sleeps, 0);
  assert.deepEqual(hydrated.files, []);
});

test("hydrateSlackMessage preserves the triggering requester when canonical author differs", async () => {
  const { hydrateSlackMessage } = await attachmentModule();
  const hydrated = await hydrateSlackMessage({
    type: "message",
    channel: "C1",
    channel_type: "channel",
    user: "UREACTOR",
    text: "cached text",
    ts: "350.1",
  }, {
    conversations: {
      history: async () => ({
        messages: [{ ts: "350.1", user: "UORIGINAL", text: "canonical text" }],
      }),
    },
  });

  assert.equal(hydrated.user, "UREACTOR");
  assert.equal(hydrated.text, "canonical text");
});

test("shapeMessages preserves safe file metadata and drops private URLs", () => {
  const [row] = shapeMessages([{
    ts: "400.1",
    user: "U1",
    text: "Files",
    files: [
      {
        id: "FXLSX",
        name: "catalog.xlsx",
        mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: 1234,
        url_private: "https://files.slack.test/private",
        url_private_download: "https://files.slack.test/download",
      },
      { id: "FPENDING", file_access: "check_file_info", size: -1 },
    ],
  }], () => "Alex");

  assert.deepEqual(row.files, [
    {
      id: "FXLSX",
      name: "catalog.xlsx",
      mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: 1234,
    },
    { id: "FPENDING", name: "", mimetype: "", size: null },
  ]);
  assert.equal(JSON.stringify(row).includes("files.slack.test"), false);
});

test("Slack ingress hydrates message and app_mention through one trigger-level dedupe boundary", () => {
  const appSource = readFileSync(new URL("../src/slack/app.js", import.meta.url), "utf8");
  const serverSource = readFileSync(new URL("../src/mcp/tools/slack-native.js", import.meta.url), "utf8");

  // Canonical hydration and trigger dedupe are behavior-tested above; keep only the Bolt wiring
  // tripwire here instead of coupling the suite to the pipeline's internal module names.
  assert.match(appSource, /app\.event\("app_mention", async \(\{ event: incoming, client, body \}\)/);
  assert.doesNotMatch(appSource, /app\.event\("app_mention", async \(\) => \{\}\)/);
  assert.match(serverSource, /\[file:/);
});
