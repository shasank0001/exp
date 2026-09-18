import { useCallback, useEffect, useState } from 'react';
import { getBridge } from '../bridge';
import type { RunState, Thread } from '../types';

const POLL_MS = 2000;
const LOG_TAIL_BYTES = 64 * 1024;

/** Split the args box on whitespace (space-separated per the bridge contract). */
function parseArgs(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/);
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return '';
  }
}

function commandLine(run: Pick<RunState, 'command' | 'args'>): string {
  return [run.command, ...run.args].join(' ').trim();
}

interface RunsPanelProps {
  thread: Thread | null;
  trusted: boolean;
  bridgeMissing: boolean;
}

/**
 * Supervised training runs (one at a time, UI-launched only).
 * Blocked until the active thread's project is trusted.
 */
export default function RunsPanel({ thread, trusted, bridgeMissing }: RunsPanelProps) {
  const threadId = thread?.id ?? null;
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const [run, setRun] = useState<RunState | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const [logs, setLogs] = useState('');
  const [logsTruncated, setLogsTruncated] = useState(false);
  const [logsComplete, setLogsComplete] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);

  const [stopArmed, setStopArmed] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  const [now, setNow] = useState(() => Date.now());
  const [tabVisible, setTabVisible] = useState(
    () => typeof document === 'undefined' || !document.hidden,
  );

  const runId = run?.id ?? null;
  const runStatus = run?.status ?? null;

  // Pause live polling while the tab is hidden.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => setTabVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Reset per-run log/stop state when a different run appears.
  useEffect(() => {
    setLogs('');
    setLogsTruncated(false);
    setLogsComplete(false);
    setLogsError(null);
    setLogsLoading(false);
    setStopArmed(false);
    setStopError(null);
  }, [runId]);

  // Poll the active run (single-flight app-wide). A null answer keeps the last
  // known run visible so finished runs stay on screen with their logs.
  useEffect(() => {
    if (!threadId || bridgeMissing || !tabVisible) return;
    const bridge = getBridge();
    if (!bridge) return;
    let cancelled = false;
    const fetchActive = async () => {
      try {
        const active = await bridge.getActiveRun();
        if (cancelled) return;
        if (active) {
          setRun(active);
          setRunError(null);
          if (active.status !== 'running') setStopArmed(false);
        }
      } catch (e) {
        if (!cancelled) setRunError(e instanceof Error ? e.message : 'Unknown error');
      }
    };
    void fetchActive();
    const timer = window.setInterval(() => { void fetchActive(); }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [threadId, bridgeMissing, tabVisible]);

  // Poll the log tail for the visible run. Stops once a finished run's logs
  // are complete; finished logs remain viewable.
  useEffect(() => {
    if (!runId || bridgeMissing || !tabVisible) return;
    if (logsComplete && runStatus !== 'running') return;
    const bridge = getBridge();
    if (!bridge) return;
    let cancelled = false;
    const fetchLogs = async (initial: boolean) => {
      if (initial) setLogsLoading(true);
      try {
        const result = await bridge.getRunLogs(runId, { tailBytes: LOG_TAIL_BYTES });
        if (cancelled) return;
        setLogs(result.logs);
        setLogsTruncated(result.truncated);
        setLogsComplete(result.complete);
        setLogsError(null);
      } catch (e) {
        if (!cancelled) setLogsError(e instanceof Error ? e.message : 'Unknown error');
      } finally {
        if (!cancelled && initial) setLogsLoading(false);
      }
    };
    void fetchLogs(true);
    const timer = window.setInterval(() => { void fetchLogs(false); }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [runId, runStatus, bridgeMissing, tabVisible, logsComplete]);

  // Tick elapsed time for a running process.
  useEffect(() => {
    if (runStatus !== 'running') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runId, runStatus]);

  const handleLaunch = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge || !threadId || launching) return;
    const cmd = command.trim();
    if (!cmd) {
      setLaunchError('Enter a command to launch.');
      return;
    }
    setLaunching(true);
    setLaunchError(null);
    try {
      const result = await bridge.launchRun(threadId, { command: cmd, args: parseArgs(argsText) });
      if ('error' in result) {
        // Single-flight conflicts and validation failures surface here.
        setLaunchError(result.error || 'Launch failed.');
      } else {
        const active = await bridge.getActiveRun();
        if (active) {
          setRun(active);
          setRunError(null);
        }
      }
    } catch (e) {
      setLaunchError(e instanceof Error ? e.message : 'Launch failed.');
    } finally {
      setLaunching(false);
    }
  }, [threadId, command, argsText, launching]);

  const handleStop = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge || !run || run.status !== 'running' || stopping) return;
    if (!stopArmed) {
      setStopArmed(true);
      return;
    }
    setStopping(true);
    setStopError(null);
    try {
      await bridge.stopRun(run.id);
      setStopArmed(false);
      const active = await bridge.getActiveRun().catch(() => null);
      if (active) setRun(active);
    } catch (e) {
      setStopError(e instanceof Error ? e.message : 'Stop failed.');
    } finally {
      setStopping(false);
    }
  }, [run, stopArmed, stopping]);

  const commandEmpty = command.trim().length === 0;

  return (
    <div>
      <div className="panel-head">
        <span className="eyebrow">Runs</span>
      </div>
      {bridgeMissing ? (
        <p className="muted small">Runs unavailable: bridge not found. Run inside Electron.</p>
      ) : thread === null ? (
        <p className="muted small">Select a thread to launch a run.</p>
      ) : !trusted ? (
        <p className="muted small">
          Runs are blocked until you trust this project. Trust it from the banner in the conversation pane first.
        </p>
      ) : (
        <div className="stack-small">
          <div className="run-form stack-small">
            <div>
              <label className="muted small" htmlFor="run-command">Command</label>
              <input
                id="run-command"
                type="text"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="python train.py"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div>
              <label className="muted small" htmlFor="run-args">Arguments (space-separated)</label>
              <input
                id="run-args"
                type="text"
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder="--epochs 10 --lr 0.001"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div>
              <span className="muted small">Working directory (read-only)</span>
              <p className="mono run-cwd wrap">{thread.projectPath}</p>
            </div>
            {commandEmpty ? (
              <p className="muted small">Command is required.</p>
            ) : null}
            {launchError ? (
              <p className="muted small" role="alert">Launch failed: {launchError}</p>
            ) : null}
            <div>
              <button className="btn" onClick={() => void handleLaunch()} disabled={commandEmpty || launching}>
                {launching ? 'Launching…' : 'Launch'}
              </button>
            </div>
          </div>

          {runError ? (
            <p className="muted small">Couldn’t load run state: {runError}</p>
          ) : null}

          {run === null ? (
            <p className="muted small">No runs yet. Launch a command to start the first supervised run.</p>
          ) : (
            <div className="change-file">
              <div className="row">
                <span className="status-pill">{run.status}</span>
                <span className="mono grow wrap">{commandLine(run)}</span>
              </div>
              <p className="muted small">
                Elapsed {formatElapsed((run.endedAt ?? now) - run.startedAt)}
                {run.status !== 'running' && run.endedAt !== null
                  ? ` · ended ${formatTime(run.endedAt)}`
                  : null}
              </p>
              {run.status !== 'running' ? (
                <p className="muted small">Exit code: {run.exitCode === null ? '—' : run.exitCode}</p>
              ) : null}
              {run.threadId !== thread.id ? (
                <p className="muted small">Started from another thread (one run at a time app-wide).</p>
              ) : null}
              {run.status === 'running' ? (
                <div className="stack-small">
                  <div className="row">
                    <button className="btn" onClick={() => void handleStop()} disabled={stopping}>
                      {stopping ? 'Stopping…' : stopArmed ? 'Confirm stop' : 'Stop'}
                    </button>
                    {stopArmed && !stopping ? (
                      <span className="muted small">Click again to confirm.</span>
                    ) : null}
                  </div>
                  {stopError ? (
                    <p className="muted small" role="alert">Stop failed: {stopError}</p>
                  ) : null}
                </div>
              ) : null}
              <div className="stack-small">
                <span className="eyebrow">Logs</span>
                {logsLoading && logs.length === 0 && !logsError ? (
                  <p className="muted small">Loading logs…</p>
                ) : (
                  <pre className="mono diff-block">{logs.length > 0 ? logs : '(no output yet)'}</pre>
                )}
                {logsError ? (
                  <p className="muted small">Couldn’t load logs: {logsError}</p>
                ) : null}
                {logsTruncated ? (
                  <p className="muted small">Showing the recent tail; older output was truncated.</p>
                ) : null}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
