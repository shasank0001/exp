// Sandbox verification against the real Electron app.
// NOTE: launched with --no-sandbox strictly as a documented environment deviation;
// the setuid helper fix on this host requires root. Does not validate the sandboxed binary itself.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');

test('desktop hosts Thread prototype in an opaque-origin frame', async () => {
  const app = await electron.launch({ args: ['--no-sandbox', '.'], timeout: 45000 });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    let frame = page.frames().find(f => f.url().includes('variants/01-thread.html'));
    if (!frame) {
      await page.waitForFunction(() => document.querySelector('iframe')?.getBoundingClientRect().height > 100, null, { timeout: 15000 });
      frame = page.frames().find(f => f.url().includes('variants/01-thread.html'));
    }
    assert.ok(frame, 'prototype frame missing');
    assert.equal(await frame.locator('h1').innerText(), 'A good baseline\nis a beginning.');
    // Sandbox without allow-same-origin: parent must not be able to read the frame document.
    const access = await page.evaluate(() => {
      const el = document.querySelector('iframe');
      return { contentDocument: el.contentDocument, contentWindow: !!el.contentWindow, desktop: typeof window.desktop?.runtimeInfo };
    });
    assert.equal(access.contentDocument, null, 'parent can read iframe document; sandbox leak');
    assert.equal(access.contentWindow, true);
    assert.equal(access.desktop, 'function', 'preload bridge missing in main frame');
    // Popup and top-level navigation are denied by the main process.
    assert.equal(await page.evaluate(() => window.open('https://example.com')), null);
  } finally {
    await app.close();
  }
});
