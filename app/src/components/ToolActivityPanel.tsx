import { useCallback, useEffect, useState } from 'react';
import { getBridge } from '../bridge';
import type { ToolEntry } from '../types';

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

/** Most-recent-first list of what the agent actually did in this thread. */
export default function ToolActivityPanel({ threadId }: { threadId: string | null }) {
  const [entries, setEntries] = useState<ToolEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!threadId) {
      setEntries(null);
      setError(null);
      return;
    }
    const bridge = getBridge();
    if (!bridge) return;
    setLoading(true);
    setError(null);
    try {
      const list = await bridge.getToolActivity(threadId);
      setEntries([...list].sort((a, b) => b.ts - a.ts));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div>
      <div className="panel-head">
        <span className="eyebrow">Tool activity</span>
        <button
          className="btn quiet"
          onClick={() => void refresh()}
          disabled={loading || threadId === null || getBridge() === undefined}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {threadId === null ? (
        <p className="muted small">Select a thread to see tool activity.</p>
      ) : getBridge() === undefined ? (
        <p className="muted small">Tool activity unavailable: bridge not found. Run inside Electron.</p>
      ) : error ? (
        <div className="stack-small">
          <p className="muted small">Couldn’t load tool activity: {error}</p>
          <button className="btn" onClick={() => void refresh()}>Retry</button>
        </div>
      ) : entries === null ? (
        <p className="muted small">Loading tool activity…</p>
      ) : entries.length === 0 ? (
        <p className="muted small">No tool activity yet in this thread.</p>
      ) : (
        <ul className="activity-list">
          {entries.map((entry, index) => (
            <li key={`${entry.ts}-${index}`} className="activity-item">
              <div className="row">
                <span className="mono">{entry.tool || '(unknown tool)'}</span>
                {entry.isError ? <span className="error-flag">error</span> : null}
                <span className="muted small grow" />
                <span className="muted small">{formatTime(entry.ts)}</span>
              </div>
              <p className="summary">{entry.summary || 'No summary.'}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
