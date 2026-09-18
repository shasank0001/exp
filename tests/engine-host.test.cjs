// Host wiring without credentials: thread lifecycle, honest auth failure,
// persistence. Uses the real pinned Pi binary; no provider calls succeed here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEngineHost } = require('../desktop/engine-host.cjs');

const PI = path.resolve(__dirname, '../node_modules/.bin/pi');

function freshHost() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-host-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-hostproj-'));
  const events = [];
  const host = createEngineHost({ userDataDir, piPath: PI, emit: (e) => events.push(e) });
  return { host, userDataDir, project, events };
}

test('host: thread lifecycle persists without credentials', async () => {
  const { host, project, events } = freshHost();
  assert.deepEqual(host.listThreads(), []);
  const thread = host.createThread({ title: 'wiring', projectPath: project });
  assert.equal(thread.engineId, 'pi');
  assert.deepEqual(host.getMessages(thread.id), []);
  const send = await host.sendPrompt(thread.id, 'Reply with OK only.');
  assert.equal(send.accepted, false, 'unauthenticated prompt must fail closed');
  assert.ok(send.error);
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes('message'), 'user message event missing');
  assert.ok(kinds.includes('error'), `error event missing: ${kinds.join(',')}`);
  const authError = events.find((e) => e.kind === 'error');
  assert.equal(authError.errorType, 'auth');
  const messages = host.getMessages(thread.id);
  assert.equal(messages.filter((m) => m.role === 'user').length, 1);
  assert.equal(messages.filter((m) => m.role === 'assistant').length, 0, 'no fake reply may persist');
  const abort = await host.abortThread(thread.id);
  assert.equal(abort.ok, true);
  await host.shutdown();
});

test('host: structured error when Pi binary is missing', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-host-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-hostproj-'));
  const events = [];
  const host = createEngineHost({ userDataDir, piPath: '/nonexistent/pi', emit: (e) => events.push(e) });
  const thread = host.createThread({ title: 't', projectPath: project });
  const send = await host.sendPrompt(thread.id, 'hi');
  assert.equal(send.accepted, false);
  assert.equal(send.error, 'Pi is not installed.');
  await host.shutdown();
});
