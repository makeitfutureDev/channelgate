// Presentation callbacks for one admitted conversation turn. Transports own the rendering
// and the final delivery. A late engine callback cannot revive a stopped thread.
export interface TurnReplySink {
  onDelta?: (text: string) => unknown;
  onEvent?: (event: { kind: string; [field: string]: unknown }) => unknown;
  onRuntimeResolved?: (runtime: { engine?: string; model?: string; [field: string]: unknown }) => unknown;
}

function untilStopped<T>(signal: AbortSignal, deliver?: (value: T) => unknown) {
  if (!deliver) return undefined;
  return (value: T) => {
    if (!signal.aborted) return deliver(value);
  };
}

export function turnReplyCallbacks(signal: AbortSignal, sink?: TurnReplySink | null): TurnReplySink {
  return {
    onDelta: untilStopped(signal, sink?.onDelta),
    onEvent: untilStopped(signal, sink?.onEvent),
    onRuntimeResolved: untilStopped(signal, sink?.onRuntimeResolved),
  };
}
