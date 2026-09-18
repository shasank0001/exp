// OpenCode engine adapter: drives `opencode run --format json` (one-shot per
// prompt) behind the same interface as the Pi adapter. Session continuity comes
// from OpenCode's --session/--continue, with the session id persisted per thread.
// Permissions are enforced via OPENCODE_CONFIG_CONTENT (no project files touched).
// Headless `ask` rules auto-reject: fail-closed by OpenCode itself.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OPENCODE_DEFAULT_MODEL = 'opencode/muse-spark-1.3-contributor-free';
const OC_PROMPT_TIMEOUT_MS = 1800000; // 30 minutes: free-tier research runs take a while
const MAX_BUFFER = 1024 * 1024;
const MAX_COLLECTED = 2000;

function readJsonc(file) {
  // Minimal JSONC reader: strips // and /* */ comments outside strings.
  const text = fs.readFileSync(file, 'utf8');
  let out = '';
  let inString = false;
  let escaped = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') { inLine = false; out += ch; }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && next === '/') { inLine = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
    out += ch;
  }
  return JSON.parse(out);
}

// Defense in depth: the user's global config merges into our runs, which would
// otherwise add MCP servers (browser automation, network) outside our permission
// policy. Neutralize every globally-configured MCP server via the `tools` glob.
// Verified by probe: `enabled:false` does NOT remove them, and neither do the
// `server_*` / `tools.server.*` patterns — only `*server*` matches the observed
// `tools.<server>.<tool>` naming. MCP support with per-server approval is a
// later milestone, not Phase 1.
function mcpToolDisables() {
  try {
    const home = process.env.HOME || os.homedir();
    const parsed = readJsonc(path.join(home, '.config', 'opencode', 'opencode.jsonc'));
    const servers = parsed && parsed.mcp && typeof parsed.mcp === 'object' ? Object.keys(parsed.mcp) : [];
    const tools = {};
    for (const name of servers) tools[`*${name}*`] = false;
    return tools;
  } catch {
    return {};
  }
}

// Phase 1 policy: read-only tools allowed; file edits allowed (OpenCode hides
// tools that carry any deny rule, so confinement relies on external_directory
// instead: paths outside the project auto-reject headless, verified by probe).
// Shell is limited to a read-only allowlist; training and installs run through
// the app's supervised Runs panel, never the agent.
function permissionConfig(projectPath) {
  return {
    tools: mcpToolDisables(),
    permission: {
      '*': 'ask',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      lsp: 'allow',
      edit: 'allow',
      bash: {
        'git *': 'allow', git: 'allow',
        'ls': 'allow', 'ls *': 'allow',
        'cat *': 'allow', 'head *': 'allow', 'tail *': 'allow',
        pwd: 'allow', 'echo *': 'allow',
        'rm *': 'deny', 'sudo *': 'deny', 'su *': 'deny',
        'mkfs *': 'deny', 'dd *': 'deny', 'shutdown *': 'deny', 'reboot *': 'deny',
        '*': 'ask',
      },
      external_directory: 'ask',
      doom_loop: 'ask',
      webfetch: 'ask',
      websearch: 'ask',
      task: 'allow',
      skill: 'allow',
      question: 'ask',
    },
  };
}

function classifyError(message) {
  const text = String(message || '');
  if (/api key|login|unauthorized|credential|token|forbidden|auth/i.test(text)) return 'auth';
  if (/quota|billing|rate limit|429|no-route|unavailable/i.test(text)) return 'quota';
  if (/session/i.test(text)) return 'session';
  return 'unknown';
}

// Translate OpenCode JSON events into the Pi-shaped events the host already
// understands, so run/send/abort/finalize logic is shared, not forked.
// Emits into `emit`; returns true when the raw event was fully consumed.
// Module-level and pure so unit tests can pin the mapping.
function translateOcEvent(event, emit) {
  switch (event.type) {
    case 'text':
      if (event.part && typeof event.part.text === 'string' && event.part.text) {
        emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: event.part.text } });
      }
      return true;
    case 'tool_use': {
      const tool = event.part || {};
      const state = tool.state || {};
      const input = (state.input && typeof state.input === 'object') ? state.input : {};
      emit({ type: 'tool_execution_start', toolCallId: tool.id, toolName: tool.tool || 'tool', args: input });
      // End is emitted only for terminal states; a pending tool must not
      // masquerade as a completion in the transcript.
      if (state.status === 'completed' || state.status === 'error' || state.status === 'failed') {
        const output = typeof state.output === 'string' ? state.output
          : (state.error ? String(state.error) : (state.status === 'error' || state.status === 'failed' ? 'failed' : 'finished'));
        emit({ type: 'tool_execution_end', toolCallId: tool.id, toolName: tool.tool || 'tool', result: output, isError: state.status !== 'completed' });
      }
      return true;
    }
    case 'error':
      // Terminal failure signal: forwarded raw so the host can surface it
      // even after acceptance. Handled by mapPiEvent's 'error' case.
      emit(event);
      return true;
    default:
      return false;
  }
}

function createOpenCodeEngine({ ocPath = 'opencode', cwd, model, stateDir } = {}) {
  let child = null;
  let buffer = '';
  const collected = [];
  const listeners = new Set();
  let stderrTail = '';
  let sessionId = null;
  const resolvedModel = model || process.env.MLCOPILOT_MODEL || OPENCODE_DEFAULT_MODEL;

  if (stateDir) {
    fs.mkdirSync(stateDir, { recursive: true });
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'oc-session.json'), 'utf8'));
      if (saved && typeof saved.sessionId === 'string') sessionId = saved.sessionId;
    } catch {
      // No prior session; the first run creates one.
    }
  }

  function rememberSession(id) {
    if (!id || sessionId) return;
    sessionId = id;
    if (stateDir) {
      try {
        const file = path.join(stateDir, 'oc-session.json');
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ sessionId }));
        fs.renameSync(tmp, file);
      } catch {
        // Session resume is best-effort; the run already works without it.
      }
    }
  }

  function push(record) {
    collected.push(record);
    if (collected.length > MAX_COLLECTED) collected.splice(0, collected.length - MAX_COLLECTED);
  }

  // Event types consumed by translateOcEvent (module scope, above). onLine skips
  // for these so each is delivered exactly once, in translated form.
  const TRANSLATED = new Set(['text', 'tool_use', 'error']);

  function onLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      push({ kind: 'unparseable', line: line.slice(0, 200) });
      return;
    }
    if (parsed && typeof parsed.sessionID === 'string') rememberSession(parsed.sessionID);
    push({ kind: parsed.type === 'response' ? 'response' : 'event', event: parsed });
    if (parsed.type !== 'response' && !TRANSLATED.has(parsed.type)) {
      for (const listener of listeners) {
        try {
          listener(parsed);
        } catch {
          // A broken listener must not break framing for the rest.
        }
      }
    }
  }

  function onData(chunk) {
    buffer += chunk;
    if (buffer.length > MAX_BUFFER) {
      push({ kind: 'unparseable', line: '[buffer cap exceeded; discarding]' });
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

  const engine = {
    // No persistent channel exists; verify the binary runs and report identity.
    async start() {
      if (!ocPath || !fs.existsSync(ocPath)) {
        const error = new Error(`OpenCode binary not found at ${ocPath}`);
        error.code = 'OC_NOT_FOUND';
        throw error;
      }
      try {
        const probe = spawnSync(ocPath, ['--version'], { timeout: 10000, encoding: 'utf8' });
        if (probe.status !== 0) throw new Error('version probe failed');
      } catch (error) {
        const failure = new Error(`OpenCode binary failed to run: ${String((error && error.message) || error)}`);
        failure.code = 'OC_NOT_FOUND';
        throw failure;
      }
    },

    request() {
      return Promise.reject(new Error('unsupported command for the OpenCode engine'));
    },

    async getState() {
      return { ok: true, data: { isStreaming: false, model: { id: resolvedModel }, sessionId } };
    },

    // Acceptance is decoupled from completion: resolve once the run is visibly
    // working (first text/tool event), reject on early error events or a bad
    // exit. Completion (or failure) always surfaces later as agent_end, so the
    // host can never wedge busy. Overall timeout kills a stuck run.
    // Default 30 minutes: free-tier research runs legitimately take a while.
    sendPrompt(message, timeoutMs = OC_PROMPT_TIMEOUT_MS) {
      if (child) return Promise.reject(new Error('a prompt is already running'));
      return new Promise((resolve) => {
        let accepted = false;
        let agentEndEmitted = false;
        let errorEvent = null;
        let done = (result) => {
          if (accepted && result.ok !== false) return;
          accepted = true;
          clearTimeout(acceptTimer);
          if (result.errorType === 'session') {
            // Stored session is stale server-side: drop it so the next prompt
            // starts fresh instead of failing the same way forever.
            sessionId = null;
            if (stateDir) {
              try { fs.unlinkSync(path.join(stateDir, 'oc-session.json')); } catch { /* best effort */ }
            }
          }
          if (result.ok === false && child) {
            // Early rejection must not leave a zombie: the host considers this
            // slot idle, so no one else will reap the process.
            engine.cancelCurrent = null;
            try { child.kill('SIGTERM'); } catch { /* already gone */ }
            const grace = setTimeout(() => { try { child && child.kill('SIGKILL'); } catch { /* already gone */ } }, 5000);
            if (grace.unref) grace.unref();
          }
          resolve(result);
        };
        const emitAgentEnd = () => {
          if (agentEndEmitted) return;
          agentEndEmitted = true;
          const record = { type: 'agent_end', willRetry: false, messages: [] };
          push({ kind: 'event', event: record });
          for (const listener of listeners) {
            try { listener(record); } catch { /* never break framing */ }
          }
        };
        const args = ['run', '--standalone', '--format', 'json', '-m', resolvedModel];
        if (sessionId) args.push('--session', sessionId, '--continue');
        args.push(message);
        const proc = spawn(ocPath, args, {
          cwd,
          env: {
            ...process.env,
            // Node's spawn sets the child's actual cwd but inherits PWD;
            // OpenCode resolves its project root from PWD, so set it explicitly.
            // Without this the agent believes it is in the app's directory.
            PWD: cwd,
            OPENCODE_CONFIG_CONTENT: JSON.stringify(permissionConfig(cwd)),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child = proc;
        engine.cancelCurrent = () => {
          try { proc.kill('SIGTERM'); } catch { /* already gone */ }
          setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } }, 5000);
        };
        const acceptTimer = setTimeout(() => {
          // Alive but silent past the window: accept; completion or failure
          // still arrives as agent_end. Never wedge the caller.
          done({ ok: true });
        }, 30000);
        const timer = setTimeout(() => {
          if (!child) return; // already exited; exit handler finalized everything
          engine.cancelCurrent();
          const timeoutEvent = { type: 'agent_timeout', timeoutMs };
          push({ kind: 'event', event: timeoutEvent });
          for (const listener of listeners) {
            try { listener(timeoutEvent); } catch { /* never break framing */ }
          }
          emitAgentEnd();
          done({ ok: false, errorType: 'timeout', error: 'Prompt timed out.' });
        }, timeoutMs);
        const finishAccept = (result) => {
          clearTimeout(timer);
          done(result);
        };
        proc.stdout.setEncoding('utf8');
        proc.stdout.on('data', (chunk) => {
          const before = collected.length;
          onData(String(chunk));
          for (let i = before; i < collected.length; i++) {
            const record = collected[i];
            if (record.kind !== 'event') continue;
            const raw = record.event;
            if (raw.type === 'error') {
              errorEvent = raw;
              // Surface terminal failures even after acceptance; the host maps
              // raw 'error' events to visible error events (never a fake reply).
              for (const listener of listeners) {
                try { listener(raw); } catch { /* never break framing */ }
              }
              if (!accepted) {
                const text = String(raw.error && raw.error.message || 'Prompt rejected.');
                finishAccept({ ok: false, errorType: classifyError(text), error: text });
              }
              continue;
            }
            // Acceptance requires evidence of work (translated content), not
            // mere lifecycle noise: a run emitting only step_start stays
            // unaccepted until the accept window or timeout decides.
            const consumed = translateOcEvent(raw, (piShaped) => {
              push({ kind: 'event', event: piShaped });
              for (const listener of listeners) {
                try { listener(piShaped); } catch { /* never break framing */ }
              }
            });
            if (!accepted && consumed) done({ ok: true });
          }
        });
        proc.stderr.on('data', (chunk) => {
          stderrTail = (stderrTail + String(chunk)).slice(-8000);
        });
        proc.on('error', (error) => {
          child = null;
          emitAgentEnd();
          finishAccept({ ok: false, errorType: 'unknown', error: String((error && error.message) || error) });
        });
        proc.on('exit', (code, signal) => {
          child = null;
          clearTimeout(timer);
          emitAgentEnd();
          if (accepted) return;
          if (errorEvent) {
            const text = String(errorEvent.error && errorEvent.error.message || 'Prompt rejected.');
            finishAccept({ ok: false, errorType: classifyError(text), error: text });
          } else if (code !== 0 || signal) {
            const tail = stderrTail.trim().split('\n').pop() || '';
            finishAccept({ ok: false, errorType: classifyError(tail), error: tail || `Process exited (code=${code}, signal=${signal}).` });
          } else {
            finishAccept({ ok: false, errorType: 'unknown', error: 'Process exited without producing output.' });
          }
        });
      });
    },

    async abort() {
      if (engine.cancelCurrent) {
        try { engine.cancelCurrent(); } catch { /* best effort */ }
        engine.cancelCurrent = null;
      }
      return { ok: true };
    },

    stop() {
      return engine.abort();
    },

    events() {
      return collected.slice();
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onExit() {
      // No persistent process exists between prompts; nothing to watch.
      return () => {};
    },
    exitInfo: () => ({ clean: true, code: null, signal: null }),
    stderrTail: () => stderrTail,
    sessionId: () => sessionId,
  };

  return engine;
}

module.exports = { createOpenCodeEngine, permissionConfig, classifyError, translateOcEvent, OPENCODE_DEFAULT_MODEL, OC_PROMPT_TIMEOUT_MS };
