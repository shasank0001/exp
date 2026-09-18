import { useCallback, useEffect, useRef, useState } from 'react';
import { getBridge } from './bridge';
import type { EngineState, Message, Thread } from './types';
import Sidebar from './components/Sidebar';
import Conversation from './components/Conversation';
import Composer from './components/Composer';
import ContextPanel from './components/ContextPanel';
import TrustBanner, { TrustReminder } from './components/TrustBanner';

export default function App() {
  const bridgeMissing = getBridge() === undefined;

  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [engine, setEngine] = useState<EngineState | null>(null);
  const [engineLoading, setEngineLoading] = useState(true);
  const [engineError, setEngineError] = useState<string | null>(null);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [toolStatus, setToolStatus] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [trust, setTrust] = useState<'checking' | 'trusted' | 'untrusted' | 'deferred'>('checking');
  const [trustSaving, setTrustSaving] = useState(false);
  const [trustError, setTrustError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<{ electron: string; platform: string; mode: string } | null>(null);
  const streamRef = useRef('');
  const activeRef = useRef<string | null>(null);

  const activeThread = threads?.find((t) => t.id === activeThreadId) ?? null;

  const refreshEngine = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge) { setEngineLoading(false); return; }
    setEngineLoading(true);
    try {
      const state = await bridge.getEngineState();
      setEngine(state);
    } catch (e) {
      setEngine({ available: false, error: e instanceof Error ? e.message : 'Engine status check failed.' });
    } finally {
      setEngineLoading(false);
    }
  }, []);

  const refreshThreads = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge) return;
    setThreadsError(null);
    try {
      const list = await bridge.listThreads();
      setThreads(list);
      setActiveThreadId((prev) => {
        if (prev && list.some((t) => t.id === prev)) return prev;
        return list.length > 0 ? list[0].id : null;
      });
    } catch (e) {
      setThreadsError(e instanceof Error ? e.message : 'Unknown error');
      setThreads([]);
    }
  }, []);

  const refreshMessages = useCallback(async (threadId: string) => {
    const bridge = getBridge();
    if (!bridge) return;
    setMessagesError(null);
    setMessages(null);
    try {
      const msgs = await bridge.getMessages(threadId);
      setMessages(msgs);
    } catch (e) {
      setMessagesError(e instanceof Error ? e.message : 'Unknown error');
      setMessages([]);
    }
  }, []);

  useEffect(() => {
    void refreshEngine();
    void refreshThreads();
    getBridge()?.runtimeInfo().then(setRuntime).catch(() => {});
  }, [refreshEngine, refreshThreads]);

  const projectPath = activeThread?.projectPath ?? null;

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge || bridgeMissing || !projectPath) return;
    let cancelled = false;
    setTrust('checking');
    setTrustError(null);
    bridge.getTrust(projectPath).then(
      (result) => {
        if (!cancelled) setTrust(result.trusted ? 'trusted' : 'untrusted');
      },
      (e) => {
        // Fail closed: without a trust answer, sending stays blocked.
        if (!cancelled) {
          setTrust('untrusted');
          setTrustError(e instanceof Error ? e.message : 'Could not check project trust.');
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bridgeMissing, projectPath]);

  useEffect(() => {
    activeRef.current = activeThreadId;
    if (activeThreadId) {
      streamRef.current = '';
      setStreamingText('');
      setStreaming(false);
      setSending(false);
      setToolStatus(null);
      setSendError(null);
      setEngineError(null);
      void refreshMessages(activeThreadId);
    } else {
      setMessages(null);
    }
  }, [activeThreadId, refreshMessages]);

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) return;
    const unsubscribe = bridge.onEngineEvent((event) => {
      if (event.threadId !== activeThreadId) return;
      switch (event.kind) {
        case 'text-delta':
          streamRef.current += event.delta;
          setStreamingText(streamRef.current);
          setStreaming(true);
          break;
        case 'message':
          setMessages((prev) => {
            if (prev === null) return [event.message];
            if (prev.some((m) => m.id === event.message.id)) {
              return prev.map((m) => (m.id === event.message.id ? event.message : m));
            }
            return [...prev, event.message];
          });
          break;
        case 'tool-start':
        case 'tool-update':
          setToolStatus(event.label ?? event.tool ?? 'Agent tool running…');
          break;
        case 'tool-end':
          setToolStatus(null);
          break;
        case 'settled':
          streamRef.current = '';
          setStreamingText('');
          setStreaming(false);
          setToolStatus(null);
          setSending(false);
          if (event.threadId) void refreshMessages(event.threadId);
          break;
        case 'error': {
          const prefix =
            event.errorType === 'auth' ? 'Authentication needed: ' :
            event.errorType === 'unavailable' ? 'Engine unavailable: ' :
            event.errorType === 'quota' ? 'Quota limit: ' : '';
          setEngineError(`${prefix}${event.error}`);
          streamRef.current = '';
          setStreamingText('');
          setStreaming(false);
          setSending(false);
          setToolStatus(null);
          break;
        }
      }
    });
    return unsubscribe;
  }, [activeThreadId, refreshMessages]);

  const handleTrustChoice = useCallback(async (trusted: boolean) => {
    const bridge = getBridge();
    if (!bridge || !projectPath || trustSaving) return;
    setTrustSaving(true);
    setTrustError(null);
    try {
      const result = await bridge.setTrust(projectPath, trusted);
      setTrust(result.trusted ? 'trusted' : 'deferred');
    } catch (e) {
      setTrustError(e instanceof Error ? e.message : 'Could not save trust choice.');
    } finally {
      setTrustSaving(false);
    }
  }, [projectPath, trustSaving]);

  const handleSend = useCallback(async () => {
    const bridge = getBridge();
    const text = draft.trim();
    const sentId = activeThreadId;
    if (!bridge || !sentId || text.length === 0 || sending || trust !== 'trusted') return;
    setSending(true);
    setSendError(null);
    try {
      const result = await bridge.sendPrompt(sentId, text);
      if (activeRef.current !== sentId) return; // user switched threads mid-flight; leave new thread alone
      if (!result.accepted) {
        setSendError(result.error ?? 'Engine did not accept the prompt.');
        setSending(false);
        return;
      }
      setDraft('');
      setStreaming(true);
    } catch (e) {
      if (activeRef.current !== sentId) return;
      setSendError(e instanceof Error ? e.message : 'Send failed.');
      setSending(false);
    }
  }, [draft, activeThreadId, sending, trust]);

  const handleAbort = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge || !activeThreadId) return;
    try {
      await bridge.abortThread(activeThreadId);
    } catch (e) {
      setEngineError(e instanceof Error ? e.message : 'Abort failed.');
    } finally {
      setSending(false);
      setStreaming(false);
    }
  }, [activeThreadId]);

  const handleNewThread = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge) return;
    setCreating(true);
    try {
      const picked = await bridge.pickProject();
      if ('cancelled' in picked && picked.cancelled) return;
      const projectPath = (picked as { path: string }).path;
      const count = (threads?.length ?? 0) + 1;
      const thread = await bridge.createThread({ title: `Thread ${count}`, projectPath });
      setThreads((prev) => (prev ? [thread, ...prev] : [thread]));
      setActiveThreadId(thread.id);
    } catch (e) {
      setThreadsError(e instanceof Error ? e.message : 'Could not create thread.');
    } finally {
      setCreating(false);
    }
  }, [threads]);

  const handlePickProject = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge || !activeThread) return;
    try {
      const picked = await bridge.pickProject();
      if ('cancelled' in picked && picked.cancelled) return;
      const projectPath = (picked as { path: string }).path;
      const thread = await bridge.createThread({ title: activeThread.title, projectPath });
      setThreads((prev) => (prev ? [thread, ...(prev ?? [])] : [thread]));
      setActiveThreadId(thread.id);
    } catch (e) {
      setThreadsError(e instanceof Error ? e.message : 'Could not switch project.');
    }
  }, [activeThread]);

  const engineUnavailable = engine !== null && !engine.available;
  const trustBlock =
    bridgeMissing || activeThreadId === null
      ? null
      : trust === 'checking'
        ? 'Checking project trust…'
        : trust !== 'trusted'
          ? 'Sending is blocked until you trust this project.'
          : null;
  const canSend =
    !bridgeMissing && activeThreadId !== null && !engineUnavailable && !engineLoading && trust === 'trusted';
  const sendDisabledReason = bridgeMissing
    ? 'Bridge unavailable — run inside Electron to send messages.'
    : activeThreadId === null
      ? 'Create or select a thread to send messages.'
      : engineLoading
        ? 'Checking engine status…'
        : engineUnavailable
          ? `Engine unavailable${engine?.error ? `: ${engine.error}` : ''} — sending is disabled.`
          : trustBlock;

  return (
    <div className="app">
      <Sidebar
        threads={threads}
        threadsError={threadsError}
        activeThreadId={activeThreadId}
        bridgeMissing={bridgeMissing}
        sidebarOpen={sidebarOpen}
        onSelect={(id) => { setActiveThreadId(id); setSidebarOpen(false); }}
        onNewThread={() => void handleNewThread()}
        onPickProject={() => void handlePickProject()}
        onRetry={() => void refreshThreads()}
        onClose={() => setSidebarOpen(false)}
        creating={creating}
      />

      <header className="workspace spread">
        <div className="row breadcrumb">
          <button
            className="btn quiet icon-btn nav-toggle"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open thread navigation"
          >
            ☰
          </button>
          <span className="muted">{activeThread ? activeThread.projectPath : 'No project'}</span>
          <span className="breadcrumb-slash" aria-hidden="true">/</span>
          <span className="breadcrumb-current">{activeThread?.title ?? 'No thread'}</span>
        </div>
        <div className="row header-actions">
          <button
            className="btn context-toggle"
            onClick={() => setContextOpen((v) => !v)}
            aria-expanded={contextOpen}
            aria-controls="thread-context"
          >
            Context
          </button>
        </div>
      </header>

      <main className="conversation-pane">
        <Conversation
          threadTitle={activeThread?.title ?? null}
          messages={messages}
          messagesError={messagesError}
          streamingText={streamingText}
          toolStatus={toolStatus}
          engineError={engineError}
          bridgeMissing={bridgeMissing}
          noThread={activeThreadId === null}
          onRetry={() => activeThreadId && void refreshMessages(activeThreadId)}
          onDismissEngineError={() => setEngineError(null)}
        />
        {activeThread && !bridgeMissing && trust === 'untrusted' ? (
          <div className="trust-dock">
            <div className="trust-dock-inner">
              <TrustBanner
                projectPath={activeThread.projectPath}
                provider={engine?.provider}
                saving={trustSaving}
                saveError={trustError}
                onTrust={() => void handleTrustChoice(true)}
                onDefer={() => void handleTrustChoice(false)}
              />
            </div>
          </div>
        ) : null}
        {activeThread && !bridgeMissing && trust === 'deferred' ? (
          <div className="trust-dock">
            <div className="trust-dock-inner">
              <TrustReminder onTrust={() => void handleTrustChoice(true)} saving={trustSaving} />
            </div>
          </div>
        ) : null}
        <Composer
          draft={draft}
          sending={sending}
          streaming={streaming}
          canSend={canSend}
          sendDisabledReason={sendDisabledReason}
          sendError={sendError}
          onDraft={setDraft}
          onSend={() => void handleSend()}
          onAbort={() => void handleAbort()}
        />
      </main>

      <ContextPanel
        thread={activeThread}
        messageCount={messages ? messages.length : null}
        engine={engine}
        engineLoading={engineLoading}
        bridgeMissing={bridgeMissing}
        contextOpen={contextOpen}
        onClose={() => setContextOpen(false)}
        onRetryEngine={() => void refreshEngine()}
      />

      <footer className="footer-status">
        <span>Local workspace{activeThread ? ` / ${activeThread.projectPath}` : ''}</span>
        <span>{engine?.available ? `Engine ready${engine.version ? ` · ${engine.version}` : ''}` : 'Engine status unknown'}{runtime ? ` · Electron ${runtime.electron}` : ''}</span>
      </footer>

      {(sidebarOpen || contextOpen) ? (
        <button
          className="panel-backdrop"
          aria-label="Close side panel"
          onClick={() => { setSidebarOpen(false); setContextOpen(false); }}
        />
      ) : null}
    </div>
  );
}
