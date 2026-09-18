// Milestone 1 gate: the Pi engine adapter must expose the spike-verified RPC surface
// through a structured API. Uses the pinned local Pi binary; no provider credentials.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createPiEngine } = require('../engines/pi-adapter.cjs');

const PI = path.resolve(__dirname, '../node_modules/.bin/pi');
const HOME = '/tmp/opencode/pi-adapter-test-home';

test('pi adapter: state, auth failure mapping, abort, clean exit, strict framing', async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  const engine = createPiEngine({ piPath: PI, home: HOME, cwd: path.resolve(__dirname, '..') });
  await engine.start();
  try {
    const state = await engine.getState();
    assert.equal(state.ok, true);
    assert.equal(state.data.isStreaming, false);
    assert.equal(state.data.sessionFile, undefined, '--no-session must be enforced by the adapter');

    const prompt = await engine.sendPrompt('Reply with OK only.');
    assert.equal(prompt.ok, false, 'unauthenticated prompt must fail');
    assert.equal(prompt.errorType, 'auth', 'adapter must classify missing credentials as auth error');

    const abort = await engine.abort();
    assert.equal(abort.ok, true);

    const unparseable = engine.events().filter(e => e.kind === 'unparseable');
    assert.equal(unparseable.length, 0, 'adapter must parse strict LF-framed JSONL');
  } finally {
    await engine.stop();
  }
  assert.equal(engine.exitInfo().clean, true, 'process must exit cleanly on stop()');
});

test('pi adapter: structured error when binary is missing', async () => {
  const engine = createPiEngine({ piPath: '/nonexistent/pi', home: HOME, cwd: '/tmp' });
  await assert.rejects(() => engine.start(), error => error.code === 'PI_NOT_FOUND');
});
