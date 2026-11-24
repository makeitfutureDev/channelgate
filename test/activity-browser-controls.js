// Use the visible controls on both the desktop table and the phone layout.
export async function selectActivityFilter(page, value) {
  const picker = page.getByLabel("Show conversations");
  if (await picker.isVisible()) {
    await picker.selectOption(value);
  } else {
    await page.locator(`#filters button[data-filter="${value}"]`).click();
  }
}

export async function openActivityRowActions(page, title) {
  const row = page.locator("tbody tr").filter({ has: page.getByRole("link", { name: title, exact: true }) });
  await row.waitFor();
  const more = row.getByRole("button", { name: "More actions", exact: true });
  if (await more.isVisible()) await more.click();
}

export async function openActivityPageMenu(page) {
  const menu = page.getByRole("button", { name: "Menu", exact: true });
  if (await menu.isVisible() && await menu.getAttribute("aria-expanded") === "false") await menu.click();
}
