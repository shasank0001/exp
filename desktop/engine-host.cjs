// Engine host (main process only): owns the thread store and one Pi adapter per
// thread, and translates Pi RPC events into the docs/ENGINE_BRIDGE.md event kinds.
// The renderer never touches the filesystem, processes, or credentials.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createStore, MAX_TEXT } = require('../services/store.cjs');
const { createRunManager } = require('../services/runs.cjs');
const { createPiEngine } = require('../engines/pi-adapter.cjs');

const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_SUMMARY_MAX = 300;
const TOOL_LOG_MAX_LINES = 1000;
const DIFF_MAX_LINES = 200;
const DIFF_MAX_FILES = 10;

function summarizeToolArgs(args) {
  if (args === undefined || args === null) return '';
  const text = typeof args === 'string' ? args : JSON.stringify(args);
  return text.length > TOOL_SUMMARY_MAX ? `${text.slice(0, TOOL_SUMMARY_MAX)}…` : text;
}

// Project-relative path touched by a tool call, or null. Never escapes the project.
function touchedPath(projectPath, args) {
  if (!args || typeof args !== 'object') return null;
  const candidate = args.path || args.file || args.filePath || args.absolutePath;
  if (typeof candidate !== 'string' || !candidate) return null;
  const resolved = path.resolve(projectPath, candidate);
  const relative = path.relative(projectPath, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative;
}

function defaultModelFromSettings() {
  // The Pi process inherits the user's HOME, so it reads this same file; mirroring
  // the default here lets the app pass --model explicitly and stay honest about it.
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pi', 'agent', 'settings.json'), 'utf8'));
    if (typeof raw.defaultModel === 'string' && raw.defaultModel.trim()) return raw.defaultModel.trim();
  } catch {
    // No settings or unreadable: Pi falls back to its built-in default.
  }
  return undefined;
}

function mapPiEvent(threadId, event) {
  const base = { threadId };
  switch (event.type) {
    case 'message_update': {
      const delta = event.assistantMessageEvent;
      if (delta && delta.type === 'text_delta' && typeof delta.delta === 'string' && delta.delta) {
        return { ...base, kind: 'text-delta', delta: delta.delta };
      }
      if (delta && delta.type === 'toolcall_start') {
        return { ...base, kind: 'tool-start', toolName: delta.toolName || 'tool' };
      }
      return null;
    }
    case 'tool_execution_start':
      return { ...base, kind: 'tool-start', tool: event.toolName || 'tool', label: `Running ${event.toolName || 'tool'}…` };
    case 'tool_execution_update':
      return { ...base, kind: 'tool-update', tool: event.toolName || 'tool', label: `Running ${event.toolName || 'tool'}…` };
    case 'tool_execution_end':
      return { ...base, kind: 'tool-end', tool: event.toolName || 'tool', label: event.isError ? `${event.toolName || 'Tool'} failed` : `${event.toolName || 'Tool'} finished`, isError: Boolean(event.isError) };
    case 'message_end':
      if (event.message && event.message.role === 'assistant') {
        const text = (event.message.content || [])
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('');
        if (text.trim()) return { ...base, kind: 'message', message: null, text };
      }
      return null;
    case 'agent_settled':
      return { ...base, kind: 'settled' };
    case 'agent_end':
      // Low-level run completion. Pi 0.73.1 RPC does not reliably emit
      // agent_settled, so the host finalizes on agent_end with willRetry=false.
      return { ...base, kind: 'agent-end', willRetry: Boolean(event.willRetry) };
    case 'extension_ui_request':
      // Approvals UI is a later milestone; never leave the agent hanging, and say so.
      // Surfaced as kind 'error' because that is what the v0.1 renderer displays.
      return { ...base, kind: 'approval-pending', method: event.method || 'unknown', title: event.title || 'Approval requested', requestId: event.id };
    default:
      return null;
  }
}

function createEngineHost({ userDataDir, piPath, emit }) {
  const recordsDir = path.join(userDataDir, 'records');
  const enginesDir = path.join(userDataDir, 'engine-home');
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(enginesDir, { recursive: true });
  const store = createStore(recordsDir);
  const runs = createRunManager(recordsDir);
  const adapters = new Map(); // threadId -> { engine, busy, starting, draft, fenced, gotAssistant }

  function getThread(threadId) {
    if (!THREAD_ID_PATTERN.test(threadId || '')) throw new Error('invalid thread id');
    const thread = store.listThreads().find((t) => t.id === threadId);
    if (!thread) throw new Error('unknown thread');
    return thread;
  }

  async function ensureAdapter(thread) {
    let slot = adapters.get(thread.id);
    if (slot) return slot;
    slot = { engine: null, busy: false, starting: true, draft: '', fenced: false, expecting: false, gotAssistant: false };
    adapters.set(thread.id, slot);
    const engine = createPiEngine({
      piPath,
      cwd: thread.projectPath,
      // Sessions are isolated per thread via --session-dir; HOME is inherited so
      // Pi reads the user's real settings and auth. Never override HOME here:
      // that would silently switch Pi to a fresh config and a different model.
      sessionDir: path.join(enginesDir, thread.id, 'sessions'),
      sessionMode: 'persistent',
      model: process.env.MLCOPILOT_MODEL || defaultModelFromSettings(),
    });
    slot.engine = engine;
    engine.onEvent((event) => handlePiEvent(thread, slot, event));
    engine.onExit((info) => {
      // The child died outside our control: evict the slot so the next prompt
      // starts fresh, and tell the renderer instead of wedging the thread.
      if (adapters.get(thread.id) === slot) adapters.delete(thread.id);
      slot.busy = false;
      slot.starting = false;
      emit({ threadId: thread.id, kind: 'error', errorType: 'unknown', error: `Pi exited unexpectedly (code=${info.code}, signal=${info.signal}). Your messages are saved; send again to restart it.` });
    });
    try {
      await engine.start();
    } catch (error) {
      if (adapters.get(thread.id) === slot) adapters.delete(thread.id);
      throw error;
    }
    slot.starting = false;
    return slot;
  }

  function trustFile() {
    return path.join(recordsDir, 'trust.json');
  }

  function readTrust() {
    try {
      const raw = JSON.parse(fs.readFileSync(trustFile(), 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      // Quarantine corruption instead of bricking trust calls; the backup keeps data.
      const backup = `${trustFile()}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(trustFile(), backup);
      } catch {
        throw error;
      }
      return {};
    }
  }

  function checkProjectPath(projectPath) {
    if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) {
      throw new Error('projectPath must be absolute');
    }
    const stat = fs.statSync(projectPath, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory()) throw new Error('projectPath must be an existing directory');
    // Canonicalize so /proj, /proj/ and symlink aliases share one trust entry.
    return fs.realpathSync(projectPath);
  }

  function toolLogFile(threadId) {
    if (!THREAD_ID_PATTERN.test(threadId || '')) throw new Error('invalid thread id');
    return path.join(recordsDir, `tools-${threadId}.jsonl`);
  }

  function recordTool(threadId, entry) {
    try {
      fs.appendFileSync(toolLogFile(threadId), `${JSON.stringify({ ts: Date.now(), ...entry })}\n`);
      const stat = fs.statSync(toolLogFile(threadId));
      if (stat.size > 512 * 1024) {
        const lines = fs.readFileSync(toolLogFile(threadId), 'utf8').split('\n').filter(Boolean);
        fs.writeFileSync(toolLogFile(threadId), `${lines.slice(-TOOL_LOG_MAX_LINES).join('\n')}\n`);
      }
    } catch {
      // Activity logging must never break the run itself.
    }
  }

  function readToolActivity(threadId) {
    let raw;
    try {
      raw = fs.readFileSync(toolLogFile(threadId), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // Skip corrupt lines.
      }
    }
    return out.slice(-200).reverse();
  }

  function git(projectPath, args) {
    const result = spawnSync('git', args, { cwd: projectPath, timeout: 15000, encoding: 'utf8' });
    return { ok: result.status === 0, out: String(result.stdout || '') };
  }

  function collectChanges(thread) {
    const probed = git(thread.projectPath, ['rev-parse', '--is-inside-work-tree']);
    if (probed.out.trim() !== 'true') {
      return { isRepo: false, files: [], touched: collectTouched(thread) };
    }
    const status = git(thread.projectPath, ['status', '--porcelain=v1', '-z']);
    if (!status.ok) {
      return { isRepo: true, files: [], touched: collectTouched(thread), error: 'Could not read git status.' };
    }
    const files = [];
    for (const entry of status.out.split('\0')) {
      if (files.length >= DIFF_MAX_FILES) break;
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      let filePath = entry.slice(3);
      // Rename entries look like "R  old -> new": show the new path.
      const arrow = filePath.indexOf(' -> ');
      if (code[0] === 'R' && arrow !== -1) filePath = filePath.slice(arrow + 4);
      if (!filePath) continue;
      if (code.trim() === '??') {
        files.push({ path: filePath, status: 'untracked', diff: '(Untracked file: content not shown.)', truncated: false });
        continue;
      }
      // Diff against HEAD so staged and unstaged changes both appear.
      const diffed = git(thread.projectPath, ['diff', 'HEAD', '--no-color', '--', filePath]);
      const lines = diffed.out.split('\n');
      files.push({
        path: filePath,
        status: code.trim(),
        diff: lines.slice(0, DIFF_MAX_LINES).join('\n') || '(No textual diff.)',
        truncated: lines.length > DIFF_MAX_LINES,
      });
    }
    return { isRepo: true, files, touched: collectTouched(thread) };
  }

  function collectTouched(thread) {
    // Reads the bounded touch fields recorded at event time (newest kept).
    let raw;
    try {
      raw = fs.readFileSync(toolLogFile(thread.id), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const seen = new Set();
    const ordered = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (typeof entry.touch === 'string' && entry.touch && !seen.has(entry.touch)) {
          seen.add(entry.touch);
          ordered.push(entry.touch);
        }
      } catch {
        // Skip corrupt lines.
      }
    }
    return ordered.slice(-50);
  }

  function recordRawToolEvent(thread, event) {
    const type = event.type;
    if (type === 'tool_execution_start') {
      const args = event.args && typeof event.args === 'object' ? event.args : undefined;
      recordTool(thread.id, {
        tool: event.toolName || 'tool',
        summary: summarizeToolArgs(args),
        isError: false,
        touch: touchedPath(thread.projectPath, args) || undefined,
      });
    } else if (type === 'tool_execution_end') {
      recordTool(thread.id, { tool: event.toolName || 'tool', summary: event.isError ? 'failed' : 'finished', isError: Boolean(event.isError) });
    } else if (type === 'message_update' && event.assistantMessageEvent && event.assistantMessageEvent.type === 'toolcall_start') {
      recordTool(thread.id, { tool: event.assistantMessageEvent.toolName || 'tool', summary: 'started', isError: false });
    }
  }

  function handlePiEvent(thread, slot, event) {
    // The activity log records what actually happened, even for fenced runs.
    recordRawToolEvent(thread, event);
    // Ignore late events from a previous generation (after abort or crash).
    if (slot.fenced || adapters.get(thread.id) !== slot) return;
    const mapped = mapPiEvent(thread.id, event);
    if (mapped && mapped.kind === 'approval-pending') {
      // No approval UI yet: decline so the run continues visibly, and say so
      // through the error channel the renderer displays.
      slot.engine.request({ type: 'extension_ui_response', id: mapped.requestId, cancelled: true }, 10000).catch(() => {});
      emit({ threadId: thread.id, kind: 'error', errorType: 'unknown', error: `The agent asked for approval (“${mapped.title}”). It was declined automatically because approval UI is not implemented yet.` });
      return;
    }
    if (!mapped) return;
    if (mapped.kind === 'text-delta') {
      slot.draft += mapped.delta;
      slot.gotAssistant = true;
      emit(mapped);
      return;
    }
    if (mapped.kind === 'message') {
      const saved = store.appendMessage(thread.id, { role: 'assistant', text: mapped.text });
      emit({ threadId: thread.id, kind: 'message', message: saved });
      slot.draft = '';
      slot.gotAssistant = true;
      return;
    }
    if (mapped.kind === 'tool-start' || mapped.kind === 'tool-update' || mapped.kind === 'tool-end') {
      slot.gotAssistant = true;
    }
    if (mapped.kind === 'agent-end' && mapped.willRetry === false) {
      finalizeRun(thread, slot);
      return;
    }
    if (mapped.kind === 'settled') {
      finalizeRun(thread, slot);
      return;
    }
    emit(mapped);
  }

  function finalizeRun(thread, slot) {
    // If deltas arrived without a message_end (provider quirk), persist the draft.
    if (slot.draft.trim()) {
      const saved = store.appendMessage(thread.id, { role: 'assistant', text: slot.draft });
      emit({ threadId: thread.id, kind: 'message', message: saved });
      slot.draft = '';
      slot.gotAssistant = true;
    }
    slot.busy = false;
    if (!slot.gotAssistant) {
      emit({ threadId: thread.id, kind: 'error', errorType: 'unknown', error: 'The model finished without producing a reply. Try again or switch models.' });
    }
    emit({ threadId: thread.id, kind: 'settled' });
  }

  return {
    listThreads: () => store.listThreads(),
    createThread: ({ title, projectPath }) => store.createThread({ title, projectPath }),
    getMessages: (threadId) => store.getMessages(getThread(threadId).id),
    getTrust: (projectPath) => {
      checkProjectPath(projectPath);
      return { trusted: readTrust()[projectPath] === true };
    },
    setTrust: (projectPath, trusted) => {
      checkProjectPath(projectPath);
      const all = readTrust();
      if (trusted) all[projectPath] = true;
      else delete all[projectPath];
      const file = trustFile();
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
      fs.renameSync(tmp, file);
      return { trusted: trusted === true };
    },
    getToolActivity: (threadId) => readToolActivity(getThread(threadId).id).map(({ ts, tool, summary, isError }) => ({ ts, tool, summary, isError: Boolean(isError) })),
    getChanges: (threadId) => collectChanges(getThread(threadId)),
    launchRun: (threadId, spec) => {
      // Runs always execute in the thread's project directory; the renderer
      // cannot choose another cwd, and the agent cannot launch runs at all.
      const thread = getThread(threadId);
      return runs.launch({ threadId: thread.id, command: spec && spec.command, args: spec && spec.args, env: spec && spec.env, cwd: thread.projectPath });
    },
    getActiveRun: () => runs.activeState(),
    getRunLogs: (runId, opts) => runs.logs(runId, opts && opts.tailBytes),
    stopRun: (runId) => runs.stop(runId),

    async sendPrompt(threadId, text) {
      const thread = getThread(threadId);
      if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) {
        return { accepted: false, error: 'Message must be 1-50000 characters.' };
      }
      let slot;
      try {
        slot = await ensureAdapter(thread);
      } catch (error) {
        const failure = error.code === 'PI_NOT_FOUND' ? 'Pi is not installed.' : String((error && error.message) || error);
        emit({ threadId, kind: 'error', errorType: 'unavailable', error: failure });
        return { accepted: false, error: failure };
      }
      if (slot.busy || slot.starting) return { accepted: false, error: 'The agent is still working. Wait or stop it first.' };
      const saved = store.appendMessage(thread.id, { role: 'user', text: text.trim() });
      emit({ threadId, kind: 'message', message: saved });
      slot.busy = true;
      slot.draft = '';
      slot.fenced = false;
      slot.gotAssistant = false;
      let result;
      try {
        result = await slot.engine.sendPrompt(text.trim());
      } catch (error) {
        slot.busy = false;
        const failure = String((error && error.message) || error);
        emit({ threadId, kind: 'error', errorType: 'unknown', error: failure });
        return { accepted: false, error: failure };
      }
      if (!result.ok) {
        slot.busy = false;
        emit({ threadId, kind: 'error', errorType: result.errorType || 'unknown', error: result.error || 'Prompt rejected.' });
        return { accepted: false, error: result.error || 'Prompt rejected.' };
      }
      return { accepted: true };
    },

    async abortThread(threadId) {
      const thread = getThread(threadId);
      const slot = adapters.get(thread.id);
      if (!slot) return { ok: true };
      // Fence the run so late events from it are dropped. The process is kept
      // so the Pi session (conversation context) survives.
      slot.fenced = true;
      slot.draft = '';
      try {
        await slot.engine.abort();
      } catch {
        // Aborting is best-effort; the fence above already dropped the run.
      }
      slot.busy = false;
      return { ok: true };
    },

    getEngineState() {
      if (!piPath || !fs.existsSync(piPath)) {
        return { available: false, error: 'Pi binary not found. Install @mariozechner/pi-coding-agent and restart.' };
      }
      try {
        const probe = spawnSync(piPath, ['--version'], { timeout: 10000, encoding: 'utf8' });
        const version = String(probe.stdout || probe.stderr || '').trim().split('\n')[0];
        if (probe.status !== 0) return { available: false, error: 'Pi binary failed to run.' };
        const model = process.env.MLCOPILOT_MODEL || defaultModelFromSettings();
        const provider = model && model.includes('/') ? model.split('/')[0] : undefined;
        return { available: true, version: version || 'unknown', provider };
      } catch {
        return { available: false, error: 'Pi binary failed to run.' };
      }
    },

    async shutdown() {
      await runs.shutdown();
      const stops = [...adapters.values()].map((slot) => slot.engine.stop().catch(() => {}));
      adapters.clear();
      await Promise.all(stops);
    },
  };
}

module.exports = { createEngineHost, mapPiEvent, summarizeToolArgs, touchedPath };
