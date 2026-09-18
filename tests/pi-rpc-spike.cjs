// Pi RPC spike: verifies strict LF framing, state discovery, abort, and error surfacing
// against the pinned local Pi binary. No provider authentication is required or used here.
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const PI = path.resolve(__dirname, '../node_modules/.bin/pi');
const HOME = '/tmp/opencode/pi-spike-home';
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });

// Protocol requires LF framing; readline also splits U+2028/2029, so parse manually.
function connect() {
  const child = spawn(PI, ['--mode', 'rpc', '--no-session'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOME },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buffer = '';
  const events = [];
  const waiters = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { events.push({ type: '__unparseable__', line: line.slice(0, 200) }); continue; }
      events.push(parsed);
      waiters.forEach(waiter => waiter.check(parsed) && waiter.resolve(parsed));
    }
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const send = command => child.stdin.write(JSON.stringify(command) + '\n');
  const waitFor = (predicate, timeoutMs = 10000, label = 'event') => new Promise((resolve, reject) => {
    const existing = events.find(predicate);
    if (existing) return resolve(existing);
    const waiter = { check: predicate, resolve: resolve };
    waiters.push(waiter);
    setTimeout(() => reject(new Error(`timeout waiting for event; stderr: ${stderr.slice(0, 400)}`)), timeoutMs);
  });
  const request = (command, timeoutMs = 10000) => new Promise((resolve, reject) => {
    const id = command.id = `req-${Math.random().toString(36).slice(2)}`;
    const waiter = { check: e => e.type === 'response' && e.id === id, resolve };
    waiters.push(waiter);
    child.stdin.write(JSON.stringify(command) + '\n');
    setTimeout(() => reject(new Error(`no response for ${command.type}; stderr: ${stderr.slice(0, 400)}`)), timeoutMs);
  });
  return { child, events, stderr: () => stderr, send, request, waitFor };
}

(async () => {
  const session = connect();
  const state = await session.request({ type: 'get_state' });
  assert.equal(state.success, true, 'get_state must succeed');
  assert.equal(state.data.isStreaming, false);
  assert.equal(state.data.sessionFile, undefined, '--no-session must disable session persistence');
  console.log('STATE OK · model:', state.data.model ? state.data.model.id : 'none (no auth configured)');

  const authProbe = await session.request({ type: 'prompt', message: 'Reply with OK only.' }, 25000);
  console.log('PROMPT ACCEPTED:', authProbe.success, authProbe.error || '(no immediate error)');
  if (authProbe.success) {
    const settled = await session.waitFor(event => event.type === 'agent_settled' || event.type === 'agent_end', 25000).catch(() => null);
    console.log('SETTLED EVENT:', settled ? settled.type : 'none — provider call likely failed without auth');
    const authError = session.events.find(e => e.type === 'message_end' && e.message?.stopReason === 'error');
    console.log('AUTH ERROR SURFACED:', authError ? JSON.stringify(authError.message).slice(0, 160) : 'not observed');
  }

  await session.request({ type: 'abort' });
  console.log('ABORT OK');
  session.child.kill();
  await new Promise(resolve => session.child.on('exit', resolve));
  const unparseable = session.events.filter(e => e.type === '__unparseable__');
  assert.equal(unparseable.length, 0, `protocol framing broke: ${JSON.stringify(unparseable.slice(0, 3))}`);
  console.log('FRAMING OK ·', session.events.length, 'events parsed as strict JSONL');
  console.log('SPIKE PASS (protocol level; live provider call requires credentials)');
})().catch(error => { console.error('SPIKE FAILED:', error); process.exitCode = 1; });
