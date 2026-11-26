// New browser-only modules own the admin-ui-* namespace. Settings search retains its
// established browser URL. The server never imports this family of generated modules.
export const adminModuleName = /^admin-(?:ui-[a-z0-9]+(?:-[a-z0-9]+)*|settings-search)$/;
