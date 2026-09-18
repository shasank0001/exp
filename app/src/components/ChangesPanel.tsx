import { useCallback, useEffect, useState } from 'react';
import { getBridge } from '../bridge';
import type { ChangesResult } from '../types';

/** Working-tree changes for the active thread, with capped diffs in monospace. */
export default function ChangesPanel({ threadId }: { threadId: string | null }) {
  const [changes, setChanges] = useState<ChangesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!threadId) {
      setChanges(null);
      setError(null);
      return;
    }
    const bridge = getBridge();
    if (!bridge) return;
    setLoading(true);
    setError(null);
    try {
      const result = await bridge.getChanges(threadId);
      setChanges(result);
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
        <span className="eyebrow">Changes</span>
        <button
          className="btn quiet"
          onClick={() => void refresh()}
          disabled={loading || threadId === null || getBridge() === undefined}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {threadId === null ? (
        <p className="muted small">Select a thread to see changes.</p>
      ) : getBridge() === undefined ? (
        <p className="muted small">Changes unavailable: bridge not found. Run inside Electron.</p>
      ) : error ? (
        <div className="stack-small">
          <p className="muted small">Couldn’t load changes: {error}</p>
          <button className="btn" onClick={() => void refresh()}>Retry</button>
        </div>
      ) : changes === null ? (
        <p className="muted small">Loading changes…</p>
      ) : !changes.isRepo ? (
        <div className="stack-small">
          <p className="muted small">
            This project is not a git repository, so no diffs are shown — only paths
            touched by tool calls in this thread.
          </p>
          {changes.touched.length === 0 ? (
            <p className="muted small">No tool activity has touched any paths in this thread yet.</p>
          ) : (
            <ul className="touched-list mono">
              {changes.touched.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          )}
        </div>
      ) : changes.files.length === 0 ? (
        <p className="muted small">No working-tree changes.</p>
      ) : (
        <ul className="changes-list">
          {changes.files.map((file) => (
            <li key={file.path} className="change-file">
              <div className="row">
                <span className="status-pill">{file.status || 'changed'}</span>
                <span className="mono grow wrap">{file.path}</span>
              </div>
              {file.diff ? (
                <pre className="mono diff-block">{file.diff}</pre>
              ) : (
                <p className="muted small">No diff available for this file.</p>
              )}
              {file.truncated ? (
                <p className="muted small">Diff truncated.</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
