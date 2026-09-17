const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ROOT_URL } = require('../desktop/policy.cjs');
const artifact = process.env.SMOKE_ARTIFACTS || 'artifacts';

async function expectCsp(page, url) {
  const response = await page.request.get(url);
  assert.equal(response.status(), 403, `CSP missing for ${url}`);
  assert.match(response.headers()['content-security-policy'] || '', /default-src 'none'/);
}
async function expectBlocked(page, url) {
  const response = await page.request.get(url);
  assert.ok([403, 404].includes(response.status()), `${url} unexpectedly allowed: ${response.status()}`);
}
(async () => {
  await fs.mkdir(artifact, { recursive: true }).catch(() => {});
  let app;
  try {
    app = await electron.launch({ args: ['--no-sandbox', '.'], timeout: 45000 });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    const frame = page.frameLocator('iframe');
    await frame.getByRole('heading', { name: 'A good baseline is a beginning.' }).waitFor({ timeout: 20000 });
    await expectCsp(page, `${ROOT_URL}/desktop/index.html`);
    await expectCsp(page, `${ROOT_URL}/variants/01-thread.html`);
    await expectBlocked(page, `${ROOT_URL}/package.json`);
    await expectBlocked(page, `${ROOT_URL}/../etc/passwd`);
    await expectBlocked(page, 'https://fonts.googleapis.com/css2?family=DM+Sans');
    await frame.getByLabel('Message your agent').fill('Check the GPU memory');
    await frame.getByLabel('Send message').click();
    await assert.rejects(() => frame.getByText('There is no memory pressure in this run').waitFor({ timeout: 4000 }), undefined, 'Prototype chat must not reply');
    const pre = await page.evaluate(() => navigator.plugins.length === 0 && !(window.desktop?.privilegedFlag));
    assert.ok(pre, 'Unexpected privileged surface in sandboxed prototype');
    await page.screenshot({ path: path.join(artifact, 'desktop.png'), fullPage: false, animations: 'disabled' }).catch(() => {});
    console.log('SMOKE OK');
  } finally { if (app) await app.close(); }
})().catch(error => { console.error('SMOKE FAILED:', error); process.exitCode = 1; });
