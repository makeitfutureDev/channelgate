// Admission notices are normal-shaped results, but no further work was admitted. Keep
// unattended delivery and durable schedule history aligned on the same refusal facts.
// result.engineStarted separately records an earlier attempt before a refused retry/fallback.
export function runAdmissionRefusalKind(result = {}) {
  if (result.licenseRefused) return "license";
  if (result.accessRefused) return "access";
  if (result.engineRefused) return "engine_disabled";
  if (result.budgetRefused || result.spendingRefused) return "spending_limit";
  return "";
}
