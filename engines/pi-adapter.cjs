// Pi engine adapter: spawns the pinned pi binary in RPC mode and exposes a
// small structured API to the app. Protocol framing follows the verified spike:
// strict JSONL, LF delimiters, trailing CR stripped (see tests/pi-rpc-spike.cjs).
const { spawn } = require('node:child_process');
const fs = require('node:fs');

function createPiEngine({ piPath = 'pi', home, cwd, sessionMode = 'none', sessionDir, model } = {}) {
  let child = null;
  let buffer = '';
  let nextId = 0;
  const pending = new Map();
  const collected = [];
  const listeners = new Set();
  const exitListeners = new Set();
  let stderrTail = '';
  const exitInfo = { clean: false, code: null, signal: null };

  function onLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      collected.push({ kind: 'unparseable', line: line.slice(0, 200) });
      return;
    }
    collected.push({ kind: parsed.type === 'response' ? 'response' : 'event', event: parsed });
    if (parsed.type !== 'response') {
      for (const listener of listeners) {
        try {
          listener(parsed);
        } catch {
          // A broken listener must not break framing for the rest.
        }
      }
    }
    if (parsed.type === 'response' && parsed.id) {
      if (timedOut.has(parsed.id)) {
        collected.push({ kind: 'late-response', event: parsed });
        timedOut.delete(parsed.id);
        return;
      }
      if (pending.has(parsed.id)) {
        const { resolve, timer } = pending.get(parsed.id);
        pending.delete(parsed.id);
        clearTimeout(timer);
        resolve(parsed);
      }
    }
  }

  function onData(chunk) {
    buffer += chunk;
    if (buffer.length > MAX_BUFFER) {
      collected.push({ kind: 'unparseable', line: '[buffer cap exceeded; discarding]' });
      buffer = '';
      return;
    }
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim()) onLine(line);
    }
  }

  // A final line without a trailing newline is still a complete record; flush on exit.
  function flushTail() {
    const tail = buffer.trim();
    buffer = '';
    if (tail) onLine(tail);
  }

  function failPending(error) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  }

  // Guard against a child that emits output without newlines: cap buffered data.
  const MAX_BUFFER = 1024 * 1024;
  const timedOut = new Set();

  const engine = {
    start() {
      if (child) return Promise.reject(new Error('engine already started'));
      if (!piPath || !fs.existsSync(piPath)) {
        const error = new Error(`Pi binary not found at ${piPath}`);
        error.code = 'PI_NOT_FOUND';
        return Promise.reject(error);
      }
      // Fresh session state; a previous start/stop cycle must not leak into the new one.
      buffer = '';
      nextId = 0;
      collected.length = 0;
      timedOut.clear();
      exitInfo.clean = false;
      exitInfo.code = null;
      exitInfo.signal = null;
      if (sessionMode !== 'none' && sessionMode !== 'persistent') {
        return Promise.reject(new Error(`unsupported sessionMode: ${sessionMode}`));
      }
      const args = sessionMode === 'persistent'
        ? ['--mode', 'rpc']
        : ['--mode', 'rpc', '--no-session'];
      if (sessionDir) args.push('--session-dir', sessionDir);
      if (model) args.push('--model', model);
      child = spawn(piPath, args, {
        cwd,
        env: { ...process.env, ...(home ? { HOME: home } : {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', onData);
      child.stdin.on('error', () => {
        // Write failures surface via request() callbacks and exit handling; never crash here.
      });
      child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + String(chunk)).slice(-8000);
      });
      child.on('error', (error) => {
        failPending(error);
      });
      child.on('exit', (code, signal) => {
        exitInfo.code = code;
        exitInfo.signal = signal;
        exitInfo.clean = code === 0;
        flushTail();
        failPending(new Error(`pi exited (code=${code}, signal=${signal})`));
        for (const listener of exitListeners) {
          try {
            listener({ ...exitInfo });
          } catch {
            // A broken listener must not break shutdown for the rest.
          }
        }
      });
      // get_state roundtrip proves the RPC channel is alive before start() resolves.
      return engine.getState().then((state) => {
        if (!state.ok) throw new Error(`pi get_state failed: ${state.error || 'unknown'}`);
      });
    },

    request(command, timeoutMs = 20000) {
      if (!child) return Promise.reject(new Error('engine not started'));
      const id = `mlc-${++nextId}`;
      const payload = { ...command, id };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          timedOut.add(id);
          reject(new Error(`timeout waiting for response to ${command.type}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
          if (error) {
            pending.delete(id);
            clearTimeout(timer);
            reject(error);
          }
        });
      });
    },

    async getState() {
      try {
        const response = await engine.request({ type: 'get_state' });
        return { ok: Boolean(response.success), data: response.data, error: response.error };
      } catch (error) {
        return { ok: false, data: null, error: String((error && error.message) || error) };
      }
    },

    async sendPrompt(message) {
      const response = await engine.request({ type: 'prompt', message }, 30000);
      if (response.success) return { ok: true };
      const error = String(response.error || '');
      const errorType = /api key|login|unauthorized|credential|token|forbidden|auth/i.test(error)
        ? 'auth'
        : /expired|quota|billing|rate limit|429/i.test(error)
          ? 'quota'
          : /session/i.test(error)
            ? 'session'
            : 'unknown';
      return { ok: false, errorType, error };
    },

    async abort() {
      const response = await engine.request({ type: 'abort' }, 15000);
      return { ok: Boolean(response.success), error: response.error };
    },

    stop() {
      if (!child) return Promise.resolve();
      const proc = child;
      child = null;
      failPending(new Error('engine stopped'));
      proc.stdin.end();
      return new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(termTimer);
          clearTimeout(killTimer);
          resolve();
        };
        proc.on('exit', done);
        const termTimer = setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
        }, 5000);
        const killTimer = setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
          done();
        }, 10000);
      });
    },

    events() {
      return collected.slice();
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    exitInfo: () => ({ ...exitInfo }),
    stderrTail: () => stderrTail,
  };

  return engine;
}

module.exports = { createPiEngine };
