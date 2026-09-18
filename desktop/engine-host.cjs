// Engine host (main process only): owns the thread store and one Pi adapter per
// thread, and translates Pi RPC events into the docs/ENGINE_BRIDGE.md event kinds.
// The renderer never touches the filesystem, processes, or credentials.
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { createStore, MAX_TEXT } = require('../services/store.cjs');
const { createPiEngine } = require('../engines/pi-adapter.cjs');

const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

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
  const adapters = new Map(); // threadId -> { engine, busy, starting, draft, fenced }

  function getThread(threadId) {
    if (!THREAD_ID_PATTERN.test(threadId || '')) throw new Error('invalid thread id');
    const thread = store.listThreads().find((t) => t.id === threadId);
    if (!thread) throw new Error('unknown thread');
    return thread;
  }

  async function ensureAdapter(thread) {
    let slot = adapters.get(thread.id);
    if (slot) return slot;
    slot = { engine: null, busy: false, starting: true, draft: '', fenced: false };
    adapters.set(thread.id, slot);
    const engine = createPiEngine({
      piPath,
      cwd: thread.projectPath,
      home: path.join(enginesDir, thread.id),
      sessionMode: 'persistent',
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

  function handlePiEvent(thread, slot, event) {
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
      emit(mapped);
      return;
    }
    if (mapped.kind === 'message') {
      const saved = store.appendMessage(thread.id, { role: 'assistant', text: mapped.text });
      emit({ threadId: thread.id, kind: 'message', message: saved });
      slot.draft = '';
      return;
    }
    if (mapped.kind === 'settled') {
      // If deltas arrived without a message_end (provider quirk), persist the draft.
      if (slot.draft.trim()) {
        const saved = store.appendMessage(thread.id, { role: 'assistant', text: slot.draft });
        emit({ threadId: thread.id, kind: 'message', message: saved });
        slot.draft = '';
      }
      slot.busy = false;
      emit(mapped);
      return;
    }
    emit(mapped);
  }

  return {
    listThreads: () => store.listThreads(),
    createThread: ({ title, projectPath }) => store.createThread({ title, projectPath }),
    getMessages: (threadId) => store.getMessages(getThread(threadId).id),

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
        return { available: true, version: version || 'unknown' };
      } catch {
        return { available: false, error: 'Pi binary failed to run.' };
      }
    },

    async shutdown() {
      const stops = [...adapters.values()].map((slot) => slot.engine.stop().catch(() => {}));
      adapters.clear();
      await Promise.all(stops);
    },
  };
}

module.exports = { createEngineHost, mapPiEvent };
