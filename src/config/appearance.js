// Deployment branding is public; a shared installed app cannot have per-viewer icons.
export const DEFAULT_LOGO_COLOR = "#ff642f";
export function normalizeLogoColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : null;
}
export function logoColor(value) { return normalizeLogoColor(value) || DEFAULT_LOGO_COLOR; }
export function logoForeground(value) {
  const color = logoColor(value);
  const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
  const luminance = rgb.map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  return luminance > .179 ? "#18382b" : "#ffffff";
}
export function channelGateLogo(value) {
  const color = logoColor(value);
  return `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" focusable="false"><rect width="48" height="48" rx="12" fill="${color}"/><g transform="translate(6 6)" fill="${logoForeground(color)}"><path d="M3 30V15a15 15 0 0 1 30 0v15h-7V15a8 8 0 0 0-16 0v15Z"/><path d="M14 30V15a4 4 0 0 1 8 0v15Z"/></g></svg>`;
}
