import type { EngineState, Thread } from '../types';
import ChangesPanel from './ChangesPanel';
import ToolActivityPanel from './ToolActivityPanel';

interface ContextPanelProps {
  thread: Thread | null;
  messageCount: number | null;
  engine: EngineState | null;
  engineLoading: boolean;
  bridgeMissing: boolean;
  contextOpen: boolean;
  onClose: () => void;
  onRetryEngine: () => void;
}

export default function ContextPanel(props: ContextPanelProps) {
  const { thread, messageCount, engine, engineLoading, bridgeMissing, contextOpen, onClose, onRetryEngine } = props;

  return (
    <aside
      className={contextOpen ? 'inspector panel-open' : 'inspector'}
      id="thread-context"
      aria-label="Thread context"
    >
      <div className="inspector-heading spread">
        <h2>Thread context</h2>
        <button className="btn quiet icon-btn panel-close" onClick={onClose} aria-label="Close thread context">✕</button>
      </div>

      <section className="inspector-section" aria-label="Project">
        <span className="eyebrow">Project</span>
        {thread ? (
          <div className="stack-small">
            <h3 className="context-title">{thread.title || '(untitled thread)'}</h3>
            <p className="muted small wrap">{thread.projectPath}</p>
            <p className="muted small">Engine: <span className="mono">{thread.engineId}</span></p>
            {messageCount !== null ? (
              <p className="muted small">{messageCount} message{messageCount === 1 ? '' : 's'}</p>
            ) : null}
          </div>
        ) : (
          <p className="muted small">No thread selected. Project details appear here once you pick a thread.</p>
        )}
      </section>

      <section className="inspector-section" aria-label="Engine state">
        <span className="eyebrow">Engine</span>
        {bridgeMissing ? (
          <p className="muted small">Engine status unavailable: bridge not found. Run inside Electron.</p>
        ) : engineLoading ? (
          <p className="muted small">Checking engine…</p>
        ) : engine ? (
          engine.available ? (
            <div className="stack-small">
              <p className="healthy"><span className="dot" aria-hidden="true" /> Available{engine.version ? ` · ${engine.version}` : ''}</p>
              {engine.provider ? (
                <p className="muted small">Provider: <span className="mono">{engine.provider}</span></p>
              ) : null}
              <p className="muted small">The agent engine is ready. Sending is enabled.</p>
            </div>
          ) : (
            <div className="stack-small">
              <p className="unhealthy" role="status"><span className="dot" aria-hidden="true" /> Unavailable</p>
              <p className="muted small">{engine.error ?? 'The engine binary is missing or failed to start. Sending is disabled.'}</p>
              <button className="btn" onClick={onRetryEngine}>Retry</button>
            </div>
          )
        ) : (
          <div className="stack-small">
            <p className="muted small">Engine status unknown.</p>
            <button className="btn" onClick={onRetryEngine}>Retry</button>
          </div>
        )}
      </section>

      <section className="inspector-section" aria-label="Tool activity">
        <ToolActivityPanel threadId={thread ? thread.id : null} />
      </section>

      <section className="inspector-section" aria-label="Changes">
        <ChangesPanel threadId={thread ? thread.id : null} />
      </section>

      <div className="context-bottom">Context stays with this thread</div>
    </aside>
  );
}
