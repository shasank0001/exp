// Run manager tests with a deterministic node fixture process. No shell, no creds.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRunManager } = require('../services/runs.cjs');

const NODE = process.execPath;
function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-runs-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-runcwd-'));
  return { dir, cwd, runs: createRunManager(dir) };
}
async function waitFor(manager, predicate, timeoutMs = 15000) {
  const started = Date.now();
  for (;;) {
    const state = manager.activeState();
    if (predicate(state)) return state;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for run state');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('runs: launch, stream logs, exit recorded', async () => {
  const { cwd, runs } = fresh();
  const launched = runs.launch({ threadId: 'th_x', command: NODE, args: ['-e', 'console.log("line-one");console.error("line-two");'], cwd });
  assert.ok(launched.runId);
  const ended = await waitFor(runs, (s) => s === null);
  assert.equal(ended, null);
  const { logs, complete } = runs.logs(launched.runId);
  assert.ok(logs.includes('line-one') && logs.includes('line-two'), `logs missing output: ${logs.slice(0, 200)}`);
  assert.equal(complete, true);
});

test('runs: exit code recorded in metadata', async () => {
  const { dir, cwd, runs } = fresh();
  const launched = runs.launch({ threadId: 'th_x', command: NODE, args: ['-e', 'process.exit(3)'], cwd });
  await waitFor(runs, (s) => s === null);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'runs', `${launched.runId}.json`), 'utf8'));
  assert.equal(meta.status, 'exited');
  assert.equal(meta.exitCode, 3);
  assert.ok(meta.endedAt >= meta.startedAt);
});

test('runs: stop kills a long process', async () => {
  const { cwd, runs } = fresh();
  const launched = runs.launch({ threadId: 'th_x', command: NODE, args: ['-e', 'setInterval(()=>console.log("tick"),100)'], cwd });
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(runs.activeState().status, 'running');
  const stopped = await runs.stop(launched.runId);
  assert.equal(stopped.ok, true);
  await waitFor(runs, (s) => s === null);
  const { logs } = runs.logs(launched.runId);
  assert.ok(logs.includes('tick'), 'expected partial output before kill');
});

test('runs: single-flight rejects a second launch', async () => {
  const { cwd, runs } = fresh();
  const first = runs.launch({ threadId: 'th_x', command: NODE, args: ['-e', 'setInterval(()=>{},100)'], cwd });
  assert.ok(first.runId);
  const second = runs.launch({ threadId: 'th_y', command: NODE, args: ['-e', 'console.log(1)'], cwd });
  assert.ok(second.error, 'second launch must be rejected');
  await runs.stop(first.runId);
  await waitFor(runs, (s) => s === null);
});

test('runs: stop is idempotent and scoped', async () => {
  const { cwd, runs } = fresh();
  assert.deepEqual(await runs.stop('run_0000000000000000'), { ok: true });
  const launched = runs.launch({ threadId: 'th_x', command: NODE, args: ['-e', 'setInterval(()=>{},100)'], cwd });
  assert.deepEqual(await runs.stop('run_ffffffffffffffff'), { ok: false, error: 'A different run is active.' });
  await runs.stop(launched.runId);
  await waitFor(runs, (s) => s === null);
  assert.deepEqual(await runs.stop(launched.runId), { ok: true });
});
test('runs: validation rejects bad specs', () => {
  const { cwd, runs } = fresh();
  assert.ok(runs.launch({ threadId: 't', command: '', cwd }).error);
  assert.ok(runs.launch({ threadId: 't', command: NODE, args: ['-e', '1'], cwd: '/nonexistent' }).error);
  assert.ok(runs.launch({ threadId: 't', command: NODE, args: new Array(51).fill('x'), cwd }).error);
  assert.ok(runs.launch({ threadId: 't', command: NODE, args: [], env: { HOME: '/x' }, cwd }).error);
  assert.ok(!runs.launch({ threadId: 't', command: NODE, args: ['-e', '1'], env: { PYTHONUNBUFFERED: '1' }, cwd }).runId === false);
  assert.throws(() => runs.logs('run_deadbeefdeadbeef'), /unknown run/);
  assert.throws(() => runs.logs('../escape'), /invalid run id/);
});
