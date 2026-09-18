const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../services/store.cjs');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-store-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-proj-'));
  return { dir, project, store: createStore(dir) };
}

test('threads persist and list newest-first', () => {
  const { dir, project, store } = fresh();
  assert.deepEqual(store.listThreads(), []);
  const a = store.createThread({ title: ' first ', projectPath: project });
  assert.equal(a.title, 'first');
  assert.equal(a.engineId, 'pi');
  const reopened = createStore(dir);
  assert.equal(reopened.listThreads().length, 1);
  assert.equal(reopened.listThreads()[0].id, a.id);
});

test('createThread validates input', () => {
  const { project, store } = fresh();
  assert.throws(() => store.createThread({ title: '', projectPath: project }), /title/);
  assert.throws(() => store.createThread({ title: 'x', projectPath: 'relative/path' }), /absolute/);
  assert.throws(() => store.createThread({ title: 'x', projectPath: '/nonexistent-dir-xyz' }), /existing directory/);
});

test('messages append, survive reopen, skip corrupt lines', () => {
  const { dir, project, store } = fresh();
  const t = store.createThread({ title: 't', projectPath: project });
  assert.deepEqual(store.getMessages(t.id), []);
  const m1 = store.appendMessage(t.id, { role: 'user', text: 'hello' });
  store.appendMessage(t.id, { role: 'assistant', text: 'hi' });
  fs.appendFileSync(path.join(dir, `messages-${t.id}.jsonl`), 'not json\n');
  assert.throws(() => store.appendMessage('nope', { role: 'user', text: 'x' }), /unknown thread/);
  assert.throws(() => store.appendMessage(t.id, { role: 'bot', text: 'x' }), /invalid role/);
  const reopened = createStore(dir);
  const messages = reopened.getMessages(t.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, m1.id);
  assert.equal(reopened.listThreads()[0].updatedAt, messages[1].createdAt);
});
