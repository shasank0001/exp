// OpenCode adapter gate: binary discovery, identity, failure mapping, abort.
// Credential-free. Live prompt flow is verified manually (needs auth).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {
  createOpenCodeEngine, permissionConfig, classifyError, translateOcEvent, OPENCODE_DEFAULT_MODEL,
} = require('../engines/opencode-adapter.cjs');

const OC = (() => {
  if (process.env.MLCOPILOT_OC_PATH && fs.existsSync(process.env.MLCOPILOT_OC_PATH)) {
    return process.env.MLCOPILOT_OC_PATH;
  }
  return '/home/shasank/.opencode/bin/opencode';
})();

test('opencode adapter: default model and permission policy shape', () => {
  assert.ok(OPENCODE_DEFAULT_MODEL.startsWith('opencode/'));
  const policy = permissionConfig('/proj');
  assert.equal(policy.permission['*'], 'ask');
  assert.equal(policy.permission.read, 'allow');
  assert.equal(policy.permission.edit, 'allow');
  assert.equal(policy.permission.bash['rm *'], 'deny');
  assert.equal(policy.permission.external_directory, 'ask');
  assert.equal(policy.tools['*arxiv*'], false);
});

test('opencode adapter: error classification', () => {
  assert.equal(classifyError('No API key found for openrouter'), 'auth');
  assert.equal(classifyError('Model unavailable: x'), 'quota');
  assert.equal(classifyError('boom'), 'unknown');
});

test('opencode adapter: start, state, abort, stop', async () => {
  if (!fs.existsSync(OC)) {
    console.log('SKIP: opencode binary not present');
    return;
  }
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-oc-'));
  const engine = createOpenCodeEngine({ ocPath: OC, cwd: stateDir, stateDir });
  await engine.start();
  const state = await engine.getState();
  assert.equal(state.ok, true);
  assert.equal(state.data.model.id, process.env.MLCOPILOT_MODEL || OPENCODE_DEFAULT_MODEL);
  const abort = await engine.abort();
  assert.equal(abort.ok, true);
  await engine.stop();
});

test('opencode adapter: structured error when binary is missing', async () => {
  const engine = createOpenCodeEngine({ ocPath: '/nonexistent/opencode', cwd: '/tmp' });
  await assert.rejects(() => engine.start(), (error) => error.code === 'OC_NOT_FOUND');
});

function writeStub(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-ocstub-'));
  const file = path.join(dir, 'oc-stub.cjs');
  fs.writeFileSync(file, `#!/usr/bin/env node
const mode = ${JSON.stringify(mode)};
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (process.argv.includes('--version')) { process.stdout.write('stub-oc 0.0.0\\n'); process.exit(0); }
if (mode === 'success') {
  say({ type: 'step_start', sessionID: 'ses_stub' });
  say({ type: 'text', sessionID: 'ses_stub', part: { text: 'STUB OK' } });
  say({ type: 'tool_use', sessionID: 'ses_stub', part: { id: 'c1', tool: 'read', state: { status: 'completed', input: { path: 'a.txt' }, output: 'hi' } } });
  process.exit(0);
} else if (mode === 'error') {
  say({ type: 'error', sessionID: 'ses_stub', error: { type: 'provider.no-route', message: 'Model unavailable: x' } });
  process.exit(0);
} else if (mode === 'slow') {
  say({ type: 'step_start', sessionID: 'ses_stub' });
  setInterval(() => {}, 1000);
} else if (mode === 'version') {
  process.stdout.write('stub-oc 0.0.0\\n');
  process.exit(0);
}
`);
  fs.chmodSync(file, 0o755);
  return file;
}

test('opencode adapter: translate mapping is pinned', () => {
  const out = [];
  assert.equal(translateOcEvent({ type: 'text', part: { text: 'hi' } }, (e) => out.push(e)), true);
  assert.deepEqual(out[0], { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } });
  out.length = 0;
  assert.equal(translateOcEvent({ type: 'tool_use', part: { id: 'c1', tool: 'read', state: { status: 'completed', input: {}, output: 'x' } } }, (e) => out.push(e)), true);
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'tool_execution_start');
  assert.equal(out[1].type, 'tool_execution_end');
  assert.equal(out[1].isError, false);
  out.length = 0;
  assert.equal(translateOcEvent({ type: 'tool_use', part: { id: 'c2', tool: 'bash', state: { status: 'running' } } }, (e) => out.push(e)), true);
  assert.equal(out.length, 1, 'pending tools must not emit phantom completions');
  assert.equal(out[0].type, 'tool_execution_start');
  out.length = 0;
  const err = { type: 'error', error: { message: 'boom' } };
  assert.equal(translateOcEvent(err, (e) => out.push(e)), true);
  assert.equal(out[0], err, 'raw errors forward untouched');
  assert.equal(translateOcEvent({ type: 'step_finish' }, () => { throw new Error('must not emit'); }), false);
});

test('opencode adapter: stub success flow accepts, translates, finalizes', async () => {
  const stub = writeStub('success');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-ocflow-'));
  const engine = createOpenCodeEngine({ ocPath: stub, cwd: dir, stateDir: path.join(dir, 'state') });
  await engine.start();
  const seen = [];
  engine.onEvent((e) => seen.push(e));
  const result = await engine.sendPrompt('hello');
  assert.equal(result.ok, true);
  await new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (seen.some((e) => e.type === 'agent_end') || Date.now() - started > 10000) { clearInterval(poll); resolve(); }
    }, 50);
  });
  const kinds = seen.map((e) => e.type);
  assert.ok(kinds.includes('message_update'), `missing deltas: ${kinds.join(',')}`);
  assert.ok(kinds.includes('tool_execution_start'), `missing tool start: ${kinds.join(',')}`);
  assert.ok(kinds.includes('tool_execution_end'), `missing tool end: ${kinds.join(',')}`);
  assert.ok(kinds.includes('agent_end'), `missing agent_end: ${kinds.join(',')}`);
  const text = seen.filter((e) => e.type === 'message_update').map((e) => e.assistantMessageEvent.delta).join('');
  assert.equal(text, 'STUB OK');
  await engine.stop();
});

test('opencode adapter: stub error flow rejects with classification', async () => {
  const stub = writeStub('error');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-ocflow-'));
  const engine = createOpenCodeEngine({ ocPath: stub, cwd: dir, stateDir: path.join(dir, 'state') });
  await engine.start();
  const seen = [];
  engine.onEvent((e) => seen.push(e));
  const result = await engine.sendPrompt('hello');
  assert.equal(result.ok, false);
  assert.equal(result.errorType, 'quota', `wrong classification: ${result.errorType}`);
  await new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (seen.some((e) => e.type === 'agent_end') || Date.now() - started > 10000) { clearInterval(poll); resolve(); }
    }, 50);
  });
  assert.ok(seen.some((e) => e.type === 'error'), 'raw error must reach listeners');
  assert.ok(seen.some((e) => e.type === 'agent_end'), 'agent_end must follow failures');
  await engine.stop();
});

test('opencode adapter: abort kills a slow run', async () => {
  const stub = writeStub('slow');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-ocflow-'));
  const engine = createOpenCodeEngine({ ocPath: stub, cwd: dir, stateDir: path.join(dir, 'state') });
  await engine.start();
  const seen = [];
  engine.onEvent((e) => seen.push(e));
  const pending = engine.sendPrompt('hello');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await engine.abort()).ok, true);
  // Acceptance may resolve either way after abort; what matters: agent_end arrives.
  await pending;
  await new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (seen.some((e) => e.type === 'agent_end') || Date.now() - started > 15000) { clearInterval(poll); resolve(); }
    }, 100);
  });
  assert.ok(seen.some((e) => e.type === 'agent_end'), 'abort must still finalize');
  await engine.stop();
});

test('opencode adapter: timeout kills and finalizes', async () => {
  const stub = writeStub('slow');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-ocflow-'));
  const engine = createOpenCodeEngine({ ocPath: stub, cwd: dir, stateDir: path.join(dir, 'state') });
  await engine.start();
  const seen = [];
  engine.onEvent((e) => seen.push(e));
  const result = await engine.sendPrompt('hello', 1500);
  assert.equal(result.ok, false);
  assert.equal(result.errorType, 'timeout');
  await new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (seen.some((e) => e.type === 'agent_end') || Date.now() - started > 10000) { clearInterval(poll); resolve(); }
    }, 50);
  });
  assert.ok(seen.some((e) => e.type === 'agent_end'), 'timeout must still finalize');
  await engine.stop();
});
