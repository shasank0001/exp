// Supervised training runs: one owned local process at a time, launched only
// from the UI. No sandboxing is claimed: the process runs as the user with full
// privileges. Safety comes from explicit launch, single-flight, wall-time limit,
// and kills restricted to the owned process group. Pure Node, unit-testable.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WALL_TIME_MS = 4 * 60 * 60 * 1000;
const MAX_ARGS = 50;
const MAX_ENV_ENTRIES = 20;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const TERM_GRACE_MS = 5000;
const KILL_GRACE_MS = 5000;
// Extra environment variables are restricted to well-known tuning prefixes
// (PYTHON*, CUDA_*, OMP_*, MKL_*, MLCOPILOT_*). PATH, LD_PRELOAD, HOME and
// friends are rejected outright. PYTHONPATH can still redirect module loading,
// but that is within the documented model: the run executes as the user with
// full privileges and no sandbox is claimed.
const ENV_ALLOW = /^(PYTHON[A-Z_]*|CUDA_[A-Z_]*|OMP_[A-Z_]*|MKL_[A-Z_]*|MLCOPILOT_[A-Z_]*)$/;

function newId() {
  return `run_${crypto.randomBytes(8).toString('hex')}`;
}

function createRunManager(baseDir) {
  const runsDir = path.join(baseDir, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  let active = null; // { id, threadId, command, args, cwd, child, logPath, startedAt, status, exitCode, endedAt, timer }

  function logPath(id) {
    if (!/^run_[0-9a-f]{16}$/.test(id)) throw new Error('invalid run id');
    return path.join(runsDir, `${id}.log`);
  }

  function metaPath(id) {
    if (!/^run_[0-9a-f]{16}$/.test(id)) throw new Error('invalid run id');
    return path.join(runsDir, `${id}.json`);
  }

  function persistMeta(run) {
    // Disk failures here must never crash supervision (e.g. inside exit handlers).
    try {
      const { child, timer, ...meta } = run;
      fs.writeFileSync(metaPath(run.id), JSON.stringify(meta, null, 2));
    } catch (error) {
      console.error(`run ${run.id}: failed to persist metadata: ${String((error && error.message) || error)}`);
    }
  }

  function appendLog(run, chunk) {
    try {
      const stat = fs.statSync(run.logPath, { throwIfNoEntry: false });
      if (stat && stat.size >= MAX_LOG_BYTES) {
        if (!run.logCapped) {
          run.logCapped = true;
          persistMeta(run);
        }
        return; // stop growing; earliest output is preserved, tail loss is flagged
      }
      fs.appendFileSync(run.logPath, chunk);
    } catch {
      // Logging must never break supervision.
    }
  }

  function finish(run, status, exitCode) {
    if (run.status !== 'running') return;
    run.status = status;
    run.exitCode = exitCode;
    run.endedAt = Date.now();
    clearTimeout(run.timer);
    persistMeta(run);
    if (active === run) active = null;
  }

  function metaLogCapped(runId) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath(runId), 'utf8'));
      return meta && meta.logCapped === true;
    } catch {
      return false;
    }
  }

  function killGroup(run, signal) {
    try {
      process.kill(-run.child.pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  return {
    launch({ threadId, command, args = [], env = {}, cwd }) {
      if (active) return { error: 'A run is already active. Stop it before launching another.' };
      if (typeof command !== 'string' || !command.trim()) return { error: 'Command must not be empty.' };
      if (!Array.isArray(args) || args.length > MAX_ARGS || args.some((a) => typeof a !== 'string')) {
        return { error: `Args must be a list of at most ${MAX_ARGS} strings.` };
      }
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return { error: 'Working directory must be absolute.' };
      try {
        const cwdStat = fs.statSync(cwd);
        if (!cwdStat.isDirectory()) return { error: 'Working directory must exist.' };
      } catch {
        return { error: 'Working directory must exist and be accessible.' };
      }
      const extra = {};
      const entries = Object.entries(env && typeof env === 'object' ? env : {});
      if (entries.length > MAX_ENV_ENTRIES) return { error: `At most ${MAX_ENV_ENTRIES} environment overrides.` };
      for (const [key, value] of entries) {
        if (typeof value !== 'string') return { error: `Environment value for ${key} must be a string.` };
        if (!ENV_ALLOW.test(key)) return { error: `Environment variable ${key} is not allowlisted.` };
        extra[key] = value;
      }
      const id = newId();
      const run = {
        id, threadId, command: command.trim(), args: args.slice(),
        cwd, status: 'running', exitCode: null, logCapped: false,
        startedAt: Date.now(), endedAt: null,
        logPath: logPath(id), child: null, timer: null,
      };
      // Create the log before spawning: if this throws, no child exists yet.
      try {
        fs.writeFileSync(run.logPath, '');
      } catch (error) {
        return { error: `Cannot write run log: ${String((error && error.message) || error)}` };
      }
      let child;
      try {
        child = spawn(command.trim(), run.args, {
          cwd,
          env: { ...process.env, ...extra },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
      } catch (error) {
        return { error: `Failed to start: ${String((error && error.message) || error)}` };
      }
      run.child = child;
      child.stdout.on('data', (chunk) => appendLog(run, chunk));
      child.stderr.on('data', (chunk) => appendLog(run, chunk));
      child.on('error', () => finish(run, 'failed', null));
      child.on('exit', (code, signal) => {
        if (run.status !== 'running') return;
        if (signal) finish(run, 'killed', null);
        else finish(run, 'exited', code);
      });
      run.timer = setTimeout(() => {
        if (run.status !== 'running') return;
        killGroup(run, 'SIGKILL');
        finish(run, 'timeout', null);
      }, WALL_TIME_MS);
      // Do not keep the app alive just for a run's wall-time timer.
      if (run.timer.unref) run.timer.unref();
      active = run;
      persistMeta(run);
      return { runId: id };
    },

    async stop(runId) {
      const run = active;
      if (!run) return { ok: true }; // idempotent: nothing running
      if (runId && run.id !== runId) return { ok: false, error: 'A different run is active.' };
      if (run.status !== 'running') return { ok: true };
      killGroup(run, 'SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, TERM_GRACE_MS));
      if (run.status === 'running') killGroup(run, 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS));
      if (run.status === 'running') finish(run, 'killed', null);
      return { ok: true };
    },

    activeState() {
      if (!active) return null;
      const { child, timer, logPath: _log, ...state } = active;
      return state;
    },

    logs(runId, tailBytes = 65536) {
      const capped = Math.max(1024, Math.min(256 * 1024, Number(tailBytes) || 65536));
      const file = logPath(runId);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch (error) {
        if (error.code === 'ENOENT') throw new Error('unknown run');
        throw error;
      }
      const start = Math.max(0, stat.size - capped);
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(stat.size - start);
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, start);
        const window = buffer.slice(0, bytesRead);
        // Avoid starting mid-line: drop to the first newline when tailing.
        // Avoid ending mid-line in tail mode: cut at the last newline so the
        // final (possibly partial) line is not shown as complete output.
        let text = window.toString('utf8');
        let truncated = start > 0;
        if (start > 0) {
          const newline = text.indexOf('\n');
          text = newline !== -1 ? text.slice(newline + 1) : '';
        }
        if (start > 0 || bytesRead < stat.size - start) {
          const lastNewline = text.lastIndexOf('\n');
          text = lastNewline !== -1 ? text.slice(0, lastNewline + 1) : '';
        }
        const known = active && active.id === runId ? active.status !== 'running' : true;
        const capped = active && active.id === runId ? Boolean(active.logCapped) : metaLogCapped(runId);
        return { logs: text, truncated: truncated || capped, complete: known };
      } finally {
        fs.closeSync(fd);
      }
    },

    shutdown() {
      // Best-effort synchronous escalation is impossible here (async waits);
      // terminate the group and let the caller await settle. The exit handler
      // persists the final state if the process dies in time.
      if (active && active.status === 'running') {
        killGroup(active, 'SIGTERM');
        return new Promise((resolve) => {
          const run = active;
          const termTimer = setTimeout(() => {
            if (run.status === 'running') killGroup(run, 'SIGKILL');
          }, 3000);
          const doneTimer = setTimeout(() => {
            clearTimeout(termTimer);
            if (run.status === 'running') finish(run, 'killed', null);
            resolve();
          }, 6000);
          if (termTimer.unref) termTimer.unref();
          if (doneTimer.unref) doneTimer.unref();
          const poll = setInterval(() => {
            if (run.status !== 'running') {
              clearTimeout(termTimer);
              clearTimeout(doneTimer);
              clearInterval(poll);
              resolve();
            }
          }, 100);
          if (poll.unref) poll.unref();
        });
      }
      return Promise.resolve();
    },
  };
}

module.exports = { createRunManager, WALL_TIME_MS, MAX_LOG_BYTES };
