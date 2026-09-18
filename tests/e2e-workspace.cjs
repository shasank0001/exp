// End-to-end workspace exercise: create a thread in a temp project, send a prompt,
// and verify the missing-engine path surfaces an honest error (the app is launched
// with MLCOPILOT_OC_PATH pointed at nothing, so no network or auth is touched and
// the call must fail closed, not fake success).
const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-e2e-'));
  fs.writeFileSync(path.join(project, 'train.py'), 'print("mock project")\n');
  const app = await electron.launch({
    args: ['--no-sandbox', '.'],
    timeout: 45000,
    env: { ...process.env, MLCOPILOT_OC_PATH: '/nonexistent/oc' },
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('navigation', { name: 'Threads' }).waitFor({ timeout: 20000 });
    const result = await page.evaluate(async (projectPath) => {
      const events = [];
      const off = window.mlcopilot.onEngineEvent((e) => events.push(e));
      const thread = await window.mlcopilot.createThread({ title: 'e2e baseline', projectPath });
      const messages0 = await window.mlcopilot.getMessages(thread.id);
      const send = await window.mlcopilot.sendPrompt(thread.id, 'Reply with OK only.');
      await new Promise((resolve) => {
        const started = Date.now();
        const poll = setInterval(() => {
          if (events.some((e) => e.kind === 'error') || Date.now() - started > 45000) {
            clearInterval(poll);
            resolve();
          }
        }, 250);
      });
      const messages1 = await window.mlcopilot.getMessages(thread.id);
      off();
      return { thread, messages0, send, events: events.map((e) => e.kind), messages1 };
    }, project);
    assert.equal(result.messages0.length, 0);
    assert.equal(result.thread.engineId, 'opencode');
    assert.equal(result.send.accepted, false, 'missing engine must not be accepted');
    assert.equal(result.send.error, 'OpenCode is not installed. Install it from https://opencode.ai and restart.');
    assert.ok(result.events.includes('error'), `expected error event, got: ${result.events.join(',')}`);
    assert.equal(result.messages1.length, 0, 'a prompt that never reached an engine leaves no transcript');
    console.log('E2E OK · send error:', result.send.error.slice(0, 80));
  } finally {
    await app.close();
  }
})().catch((error) => { console.error('E2E FAILED:', error); process.exitCode = 1; });
