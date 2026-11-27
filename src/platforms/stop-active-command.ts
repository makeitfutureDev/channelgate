export function isStopActiveCommand(text: string) {
  return /^\/?stop\s+active$/i.test(text.trim());
}
