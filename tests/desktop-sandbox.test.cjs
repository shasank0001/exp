// Workspace verification against the real Electron app.
// NOTE: launched with --no-sandbox strictly as a documented environment deviation;
// the setuid helper fix on this host requires root. Does not validate the sandboxed binary itself.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');

test('workspace loads Thread UI with an isolated bridge', async () => {
  const app = await electron.launch({ args: ['--no-sandbox', '.'], timeout: 45000 });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('navigation', { name: 'Threads' }).waitFor({ timeout: 20000 });
    // Preload bridge is present and narrow: no Node access in the renderer.
    const bridge = await page.evaluate(() => ({
      hasBridge: typeof window.mlcopilot?.listThreads === 'function',
      hasNode: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
      hasDesktop: typeof window.desktop !== 'undefined',
    }));
    assert.equal(bridge.hasBridge, true, 'window.mlcopilot bridge missing');
    assert.equal(bridge.hasNode, false, 'renderer has Node access; isolation broken');
    assert.equal(bridge.hasDesktop, false, 'legacy prototype bridge must not exist in workspace');
    // Engine state is reported honestly (Pi binary present, no credentials configured).
    const engine = await page.evaluate(() => window.mlcopilot.getEngineState());
    assert.equal(engine.available, true, `engine should be detected: ${engine.error || ''}`);
    // Popup windows are denied by the main process.
    assert.equal(await page.evaluate(() => window.open('https://example.com')), null);
  } finally {
    await app.close();
  }
});
