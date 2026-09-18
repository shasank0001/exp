const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOpenCodeEngine } = require('/home/shasank/shasank/Deep_learing/projects/ml-co/engines/opencode-adapter.cjs');
(async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-ad-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlc-ads-'));
  console.log('SPAWN CWD:', cwd);
  const engine = createOpenCodeEngine({ ocPath: '/home/shasank/.opencode/bin/opencode', cwd, stateDir });
  await engine.start();
  const texts = [];
  engine.onEvent((e) => {
    const d = e.assistantMessageEvent;
    if (d && d.type === 'text_delta') texts.push(d.delta);
  });
  const r = await engine.sendPrompt('What is your current working directory? Reply with just the absolute path, no tools.');
  console.log('SEND:', JSON.stringify(r));
  await new Promise((res) => setTimeout(res, 45000));
  console.log('MODEL SEES:', JSON.stringify(texts.join('')));
  await engine.stop();
})().catch((e) => { console.error('FAILED:', e); process.exitCode = 1; });
