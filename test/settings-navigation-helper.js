// Reach a setting through the same category and disclosure controls as an operator.
// Other feature tests use this when the field they exercise lives in a collapsed card.
export async function openSetting(page, target) {
  const field = typeof target === "string" ? page.locator(target) : target;
  await field.waitFor({ state: "attached" });
  const section = await field.evaluate((el) => el.closest(".setsec").dataset.sec);
  const category = page.locator("#settings-category");
  if (await category.isVisible()) {
    await category.selectOption(section);
  } else {
    await page.locator(`#settings-nav [data-sec="${section}"]`).click();
  }
  const disclosures = field.locator("xpath=ancestor-or-self::details");
  for (const details of await disclosures.all()) {
    if (!(await details.evaluate((el) => el.open))) {
      await details.locator(":scope > summary").click();
    }
  }
}
