import type { Thread } from '../types';

interface SidebarProps {
  threads: Thread[] | null;
  threadsError: string | null;
  activeThreadId: string | null;
  bridgeMissing: boolean;
  sidebarOpen: boolean;
  onSelect: (id: string) => void;
  onNewThread: () => void;
  onPickProject: () => void;
  onRetry: () => void;
  onClose: () => void;
  creating: boolean;
}

function projectName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

export default function Sidebar(props: SidebarProps) {
  const {
    threads, threadsError, activeThreadId, bridgeMissing,
    sidebarOpen, onSelect, onNewThread, onPickProject, onRetry, onClose, creating,
  } = props;
  const active = threads?.find((t) => t.id === activeThreadId) ?? null;

  return (
    <aside
      className={sidebarOpen ? 'sidebar panel-open' : 'sidebar'}
      aria-label="Thread navigation"
    >
      <div className="sidebar-brand">
        <span className="row logo" aria-label="ML Copilot">
          <span className="mark">m/</span>
          <span className="app-title">ML Copilot</span>
        </span>
        <button className="btn quiet icon-btn panel-close" onClick={onClose} aria-label="Close navigation">
          ✕
        </button>
      </div>

      <button
        className="workspace-select"
        onClick={onPickProject}
        title={active ? active.projectPath : 'Choose a project folder'}
      >
        <span className="workspace-icon" aria-hidden="true">▦</span>
        <span className="grow">
          <strong>{active ? projectName(active.projectPath) : 'No project selected'}</strong>
          <small>{active ? active.projectPath : 'Local workspace'}</small>
        </span>
        <span aria-hidden="true">›</span>
      </button>

      <button className="btn new-thread" onClick={onNewThread} disabled={creating || bridgeMissing}>
        <span aria-hidden="true">+</span> {creating ? 'Creating…' : 'New thread'}
      </button>

      <nav aria-label="Threads">
        <div className="nav-label">Threads</div>
        {bridgeMissing ? (
          <p className="empty-note">Bridge unavailable. Start the app through Electron to load threads.</p>
        ) : threads === null ? (
          <p className="empty-note">Loading threads…</p>
        ) : threadsError ? (
          <div className="empty-note">
            <p>Couldn’t load threads: {threadsError}</p>
            <button className="btn" onClick={onRetry}>Retry</button>
          </div>
        ) : threads.length === 0 ? (
          <p className="empty-note">No threads yet. Create one to start a conversation.</p>
        ) : (
          threads.map((t) => (
            <button
              key={t.id}
              className={t.id === activeThreadId ? 'nav-item selected' : 'nav-item'}
              aria-current={t.id === activeThreadId ? 'page' : undefined}
              onClick={() => onSelect(t.id)}
              title={t.projectPath}
            >
              <span className="thread-dot" aria-hidden="true" />
              <span className="nav-title">{t.title || '(untitled thread)'}</span>
            </button>
          ))
        )}
      </nav>

      <div className="sidebar-bottom">
        <div className="local-note">
          <span aria-hidden="true">▦</span>
          <div>
            <strong>Your work stays yours.</strong>
            <p>Local files. You control compute.</p>
          </div>
        </div>
        <div className="profile" aria-label="Workspace status">
          <span className="avatar" aria-hidden="true">LW</span>
          <span className="grow">
            <strong>Local workspace</strong>
            <small>Local · no cloud sync</small>
          </span>
        </div>
      </div>
    </aside>
  );
}
