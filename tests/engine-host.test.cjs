// Host wiring without credentials: thread lifecycle, honest auth failure,
// persistence. Uses the real pinned Pi binary; no provider calls succeed here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEngineHost, summarizeToolArgs, touchedPath } = require('../desktop/engine-host.cjs');

const PI = path.resolve(__dirname, '../node_modules/.bin/pi');

function freshHost(overrides = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-host-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-hostproj-'));
  const events = [];
  // Point at a missing OpenCode binary so tests never touch network/auth.
  const host = createEngineHost({ userDataDir, piPath: PI, ocPath: '/nonexistent/oc', emit: (e) => events.push(e), ...overrides });
  return { host, userDataDir, project, events };
}

test('host: thread lifecycle persists without credentials', async () => {
  const { host, project, events } = freshHost();
  assert.deepEqual(host.listThreads(), []);
  const thread = host.createThread({ title: 'wiring', projectPath: project });
  assert.equal(thread.engineId, 'opencode');
  assert.deepEqual(host.getMessages(thread.id), []);
  const send = await host.sendPrompt(thread.id, 'Reply with OK only.');
  assert.equal(send.accepted, false, 'missing engine binary must fail closed');
  assert.equal(send.error, 'OpenCode is not installed. Install it from https://opencode.ai and restart.');
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes('error'), `error event missing: ${kinds.join(',')}`);
  const engineError = events.find((e) => e.kind === 'error');
  assert.equal(engineError.errorType, 'unavailable');
  // A prompt that never reached an engine leaves no transcript behind.
  assert.deepEqual(host.getMessages(thread.id), []);
  const abort = await host.abortThread(thread.id);
  assert.equal(abort.ok, true);
  await host.shutdown();
});

test('host: trust roundtrip is per project path', async () => {
  const { host, project } = freshHost();
  assert.deepEqual(host.getTrust(project), { trusted: false });
  assert.deepEqual(host.setTrust(project, true), { trusted: true });
  assert.deepEqual(host.getTrust(project), { trusted: true });
  assert.deepEqual(host.setTrust(project, false), { trusted: false });
  assert.deepEqual(host.getTrust(project), { trusted: false });
  assert.throws(() => host.getTrust('relative/path'), /absolute/);
  await host.shutdown();
});

test('host: changes in a git repo show diffs; plain folders show touched only', async () => {
  const { host, project } = freshHost();
  const { execFileSync } = require('node:child_process');
  const git = (args) => execFileSync('git', args, { cwd: project, timeout: 15000 });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(project, 'a.txt'), 'one\n');
  git(['add', 'a.txt']);
  git(['commit', '-qm', 'init']);
  fs.writeFileSync(path.join(project, 'a.txt'), 'one\ntwo\n');
  const thread = host.createThread({ title: 'changes', projectPath: project });
  const changes = host.getChanges(thread.id);
  assert.equal(changes.isRepo, true);
  assert.equal(changes.files.length, 1);
  assert.equal(changes.files[0].path, 'a.txt');
  assert.ok(changes.files[0].diff.includes('+two'), 'diff must contain the added line');
  assert.equal(changes.files[0].truncated, false);

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-plain-'));
  const thread2 = host.createThread({ title: 'plain', projectPath: plain });
  const changes2 = host.getChanges(thread2.id);
  assert.equal(changes2.isRepo, false);
  assert.deepEqual(changes2.files, []);
  await host.shutdown();
});

test('host: tool arg helpers summarize and contain paths', () => {
  assert.equal(summarizeToolArgs({ command: 'ls' }), '{"command":"ls"}');
  assert.ok(summarizeToolArgs({ x: 'y'.repeat(1000) }).endsWith('…'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-touch-'));
  assert.equal(touchedPath(project, { path: 'a/b.py' }), path.join('a', 'b.py'));
  assert.equal(touchedPath(project, { path: '../escape' }), null);
  assert.equal(touchedPath(project, { path: '/etc/passwd' }), null);
  assert.equal(touchedPath(project, null), null);
});
test('host: corrupt trust.json is quarantined, not fatal', async () => {
  const { host, project, userDataDir } = freshHost();
  fs.writeFileSync(path.join(userDataDir, 'records', 'trust.json'), '{broken');
  assert.deepEqual(host.getTrust(project), { trusted: false });
  const backups = fs.readdirSync(path.join(userDataDir, 'records')).filter((f) => f.startsWith('trust.json.corrupt-'));
  assert.equal(backups.length, 1);
  assert.deepEqual(host.setTrust(project, true), { trusted: true });
  assert.deepEqual(host.getTrust(project), { trusted: true });
  await host.shutdown();
});

test('host: renames show the new path with a diff', async () => {
  const { host, project } = freshHost();
  const { execFileSync } = require('node:child_process');
  const git = (args) => execFileSync('git', args, { cwd: project, timeout: 15000 });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(project, 'old.txt'), 'data\n');
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
  execFileSync('git', ['mv', 'old.txt', 'new name.txt'], { cwd: project, timeout: 15000 });
  const thread = host.createThread({ title: 'rename', projectPath: project });
  const changes = host.getChanges(thread.id);
  assert.equal(changes.isRepo, true);
  assert.ok(changes.files.some((f) => f.path === 'new name.txt'), `rename target missing: ${JSON.stringify(changes.files.map((f) => f.path))}`);
  await host.shutdown();
});
test('host: structured error when engine binaries are missing', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-host-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-hostproj-'));
  const events = [];
  const host = createEngineHost({ userDataDir, piPath: '/nonexistent/pi', ocPath: '/nonexistent/oc', emit: (e) => events.push(e) });
  const thread = host.createThread({ title: 't', projectPath: project });
  assert.equal(thread.engineId, 'opencode');
  const send = await host.sendPrompt(thread.id, 'hi');
  assert.equal(send.accepted, false);
  assert.equal(send.error, 'OpenCode is not installed. Install it from https://opencode.ai and restart.');
  const legacy = host.createThread({ title: 'legacy', projectPath: project, engineId: 'pi' });
  const sendLegacy = await host.sendPrompt(legacy.id, 'hi');
  assert.equal(sendLegacy.accepted, false);
  assert.equal(sendLegacy.error, 'Pi is not installed.');
  await host.shutdown();
});

test('host: agent_timeout maps to an internal run marker', () => {
  const { mapPiEvent } = require('../desktop/engine-host.cjs');
  assert.deepEqual(mapPiEvent('th_x', { type: 'agent_timeout' }), { threadId: 'th_x', kind: 'agent-timeout' });
});

test('host: lifecycle event types are activity-logged, deltas are not', () => {
  const { mapPiEvent } = require('../desktop/engine-host.cjs');
  assert.equal(mapPiEvent('th_x', { type: 'step_finish', reason: 'stop' }), null);
  assert.equal(mapPiEvent('th_x', { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } }), null);
});
