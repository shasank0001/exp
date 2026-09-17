const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ROOT_URL, CSP, resolveAsset } = require('../desktop/policy.cjs');
const root = path.resolve(__dirname, '..');

test('serves only desktop and prototype assets over the app scheme', () => {
  assert.match(CSP, /^default-src 'none'/);
  assert.equal(ROOT_URL, 'mlcopilot://app');
  const ok = rel => resolveAsset(`${ROOT_URL}/${rel}`, root);
  assert.equal(ok('desktop/index.html'), path.join(root, 'desktop/index.html'));
  assert.equal(ok('desktop/host.js'), path.join(root, 'desktop/host.js'));
  assert.equal(ok('variants/01-thread.html'), path.join(root, 'variants/01-thread.html'));
  assert.equal(ok('variants/shared.css'), path.join(root, 'variants/shared.css'));
  for (const denied of ['package.json', 'desktop/main.cjs', 'desktop/preload.cjs', 'docs/PLAN.md', 'variants/../desktop/main.cjs', 'desktop/../.git/config', 'secret.txt', '%2e%2e/package.json', 'desktop/index.html?x=1']) {
    assert.equal(ok(denied), null, `must deny: ${denied}`);
  }
  for (const url of ['https://example.com/x.js', 'file:///etc/passwd', 'mlcopilot://evil/x.js', 'mlcopilot://app', 'javascript:alert(1)']) {
    assert.equal(resolveAsset(url, root), null, `must deny: ${url}`);
  }
});
