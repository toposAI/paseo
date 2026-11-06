// 窓口スレを開き、帯から指示一覧を開いた状態にする(件数の二重表示の確認用)。
export default async function setup(page, width) {
  await page.waitForSelector("[data-testid=startup-splash]", { state: "detached", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
  if (width === "iphone") {
    await page.locator("[data-testid=menu-button]:visible").first().click().catch(() => {});
    await page.waitForTimeout(1500);
  }
  const win = page.getByText(/^窓口$/).first();
  await win.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(5000);
  await page.locator('[aria-label*="指示一覧を開く"]:visible').first().click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(3000);
}
