// These are spawn facts, not the provider's later response metadata. Deliver them per attempt,
// never in a shared channel instruction file: concurrent threads can select different models,
// a retry can change the model, and healing/failover can change session state or the engine.
export function runtimeIdentityPreamble({ engine, model, effort, fresh }) {
  const facts = {
    engine,
    configured_model: model || null,
    configured_effort: effort || null,
    session: fresh ? "fresh" : "resumed",
  };
  return `[Gateway runtime for THIS attempt: ${JSON.stringify(facts)}\n`
    + "Use these current facts instead of earlier runtime notes or generic model self-descriptions. "
    + "For engine/model questions, quote engine and configured_model exactly, identifying the model as configured. "
    + "This is the configured model selection, not a provider-reported model identity; aliases may resolve differently. "
    + "null means the harness default is not exposed at prompt construction: say unknown rather than guessing. "
    + "session is the gateway's fresh/resume choice for this attempt, not a claim about how much conversation history is present.]\n\n";
}
