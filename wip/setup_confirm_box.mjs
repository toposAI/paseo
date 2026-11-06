// 確認箱を開いた状態にする(撮影・実測の前処理)。7fb7 の見た目確認で使う。
export default async function setup(page) {
  await page.waitForSelector("[data-testid=startup-splash]", { state: "detached", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const btn = page.locator("[data-testid=plugin-sidebar-footer-topos-confirm-box-judgment]:visible").first();
  try {
    await btn.click({ timeout: 8000 });
  } catch {
    await page.locator("[data-testid=menu-button]:visible").first().click().catch(() => {});
    await page.waitForTimeout(1500);
    await btn.click({ timeout: 8000 }).catch(() => {});
  }
  await page.waitForTimeout(4000);
}
