// Native adapters register the conversation and verify the event before entering this flow.
// Resolve the session only after channel admission: quoted replies can persist a session mapping.
import { isAdmin, isApproved } from "../config/store.js";
import { isAuthorized } from "./modes.js";
import { getThreadSudo } from "./thread-engine.js";

type Awaitable<T> = T | Promise<T>;
type Denial = "unauthorized" | "sudo-admin-only";

interface MessageScope {
  actorId: string;
  isDM: boolean;
  meta: Record<string, unknown>;
  slug: string;
  threadKey: string | (() => string);
}

interface Admission {
  authorIsAdmin: boolean;
  authorApproved: boolean;
  denial: Denial | null;
  threadKey: string;
}

export async function checkMessageAdmission(scope: MessageScope): Promise<Admission> {
  const { actorId, isDM, meta, slug } = scope;
  const authorIsAdmin = await isAdmin(actorId);
  const authorApproved = await isApproved(actorId);
  const identity = { authorIsAdmin, authorApproved };
  if (!isAuthorized(meta, actorId, isDM, { isAdminUser: authorIsAdmin, isApprovedUser: authorApproved })) {
    return { ...identity, denial: "unauthorized", threadKey: "" };
  }
  const threadKey = typeof scope.threadKey === "function" ? scope.threadKey() : scope.threadKey;
  const denial = await getThreadSudo(slug, threadKey) && !authorIsAdmin ? "sudo-admin-only" : null;
  return { ...identity, denial, threadKey };
}

// A preparation stage can answer directly, for example when transcription produced no usable
// prompt. A tagged result distinguishes that case from ordinary (including empty) stage data.
const handled = Symbol("handled message");
interface Handled<T> { [handled]: true; value: T }
export function handledMessage(): Handled<undefined>;
export function handledMessage<T>(value: T): Handled<T>;
export function handledMessage<T>(value?: T): Handled<T | undefined> {
  return { [handled]: true, value };
}
function wasHandled<T, R>(value: T | Handled<R>): value is Handled<R> {
  return typeof value === "object" && value !== null && handled in value;
}

// Slack snapshots downloaded inputs in its durable queue row. The other connectors download
// under the queue owner's cancellation signal. In either case, ownership spans execution and
// final delivery. Adapters supply native queue handles, file access and reply rendering.
export interface MessageTurn<Before, Lane, Prepared, Answer, Result> {
  prepareForQueue?: () => Awaitable<Before | Handled<Result>>;
  withQueue: (before: Before, start: (lane: Lane) => Promise<Result>) => Awaitable<Result>;
  prepareForRun?: (before: Before, lane: Lane) => Awaitable<Prepared | Handled<Result>>;
  run: (prepared: Prepared, lane: Lane, before: Before) => Awaitable<Answer>;
  deliver: (answer: Answer, prepared: Prepared, lane: Lane, before: Before) => Awaitable<Result>;
  onRunError?: (error: unknown, lane: Lane, before: Before) => Awaitable<Result>;
}

async function processTurn<Before = undefined, Lane = undefined, Prepared = undefined, Answer = unknown, Result = unknown>(
  turn: MessageTurn<Before, Lane, Prepared, Answer, Result>,
): Promise<Result> {
  const before = await turn.prepareForQueue?.();
  if (wasHandled(before)) return before.value;
  return turn.withQueue(before as Before, async lane => {
    let prepared;
    let answer;
    try {
      prepared = await turn.prepareForRun?.(before as Before, lane);
      if (wasHandled(prepared)) return prepared.value;
      answer = await turn.run(prepared as Prepared, lane, before as Before);
    } catch (error) {
      if (turn.onRunError) return turn.onRunError(error, lane, before as Before);
      throw error;
    }
    // A transport failure while posting a final answer must retain the caller's delivery/retry
    // semantics. Passing it through onRunError could produce a second, misleading answer.
    return turn.deliver(answer, prepared as Prepared, lane, before as Before);
  });
}

interface IncomingMessage<Result> extends MessageScope {
  denied: (reason: Denial, identity: Admission) => Awaitable<Result>;
  admitted: (identity: Admission, execute: typeof processTurn) => Awaitable<Result>;
}

export async function dispatchIncomingMessage<Result>(message: IncomingMessage<Result>): Promise<Result> {
  const identity = await checkMessageAdmission(message);
  if (identity.denial) return message.denied(identity.denial, identity);
  return message.admitted(identity, processTurn);
}
