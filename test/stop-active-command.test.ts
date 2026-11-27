import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ensureTestEnv } from "./helpers.js";

ensureTestEnv();
const load = (name: string) => import(name);
const { createIngest } = await load("../src/platforms/ingest.js");
const { makeInbound } = await load("../src/platforms/inbound.js");
const { setUser } = await load("../src/config/store.js");

for (const platform of ["googlechat", "msteams"]) {
  test(platform + " targets the current author and preserves their queued successor", async () => {
    const author = "first-" + platform, other = "next-" + platform;
    await setUser(author, { approved: true }); await setUser(other, { approved: true });
    const messages: string[] = [], started: string[] = [];
    let nextDone!: () => void;
    const next = new Promise<void>(resolve => { nextDone = resolve; });
    const ingest = createIngest({
      connector: { platform, async post({text}: {text:string}) { messages.push(text); return {messageId:"p" + messages.length}; },
        edit: async () => {}, directory: async () => ({ map: new Map(), maxWords: 1 }) },
      run: async ({ authorId, signal }: { authorId: string; signal: AbortSignal }) => {
        started.push(authorId);
        if (authorId === other) await next;
        else await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), {once:true}));
        return { content: authorId + " done", engine: "claude" };
      },
    });
    const event = (userId: string, messageId: string, text: string) => makeInbound({
      platform, conversationId: "controls-" + platform, kind: "channel", threadKey: "thread", mentionsBot: true, userId, messageId, text,
    });
    const active = ingest(event(author,"a","Start the first turn"));
    for (let i=0; i<200 && !started.length; i++) await delay(5);
    assert.deepEqual(started,[author]);
    const queued = ingest(event(other,"b","Complete the follow-up"));
    const control = event(author,"c","stop active");
    await ingest(event(other,"d","/stop active"));
    assert.ok(messages.some(text => /Only the run author/.test(text)));
    await ingest(control);
    await active;
    for (let i=0; i<200 && started.length<2; i++) await delay(5);
    assert.deepEqual(started,[author,other]);
    await ingest(control);
    assert.ok(messages.some(text => /already stopped/.test(text)));
    nextDone(); await queued;
  });
}
