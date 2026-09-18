# Engine bridge contract (preload `window.mlcopilot`)

Version 0.3 — Milestone 4 adds supervised training runs. One run at a time,
launched only from the UI. The agent has no launch capability.

## Methods (all return promises)

- `runtimeInfo() -> { electron: string, platform: string, mode: 'workspace' }`
  Desktop shell version for the status bar. No privileges.
- `pickProject() -> { path: string } | { cancelled: true }`
  Opens the native directory picker in main. No path touch in renderer.
- `listThreads() -> Thread[]`
- `createThread({ title: string, projectPath: string }) -> Thread`
- `getMessages(threadId: string) -> Message[]`
- `sendPrompt(threadId: string, text: string) -> { accepted: boolean, error?: string }`
- `abortThread(threadId: string) -> { ok: boolean }`
- `getEngineState() -> { available: boolean, version?: string, provider?: string, error?: string }`
  `available=false` when the Pi binary is missing or fails to start; the
  renderer shows this honestly and disables sending. `provider` names the model
  provider that project content may be sent to (e.g. `"openrouter"`).
- `getTrust(projectPath: string) -> { trusted: boolean }`
- `setTrust(projectPath: string, trusted: boolean) -> { trusted: boolean }`
  The renderer must require explicit trust before the first prompt in a project
  and show what trust means (below). Trust is stored locally, per project path.
- `getToolActivity(threadId: string) -> ToolEntry[]`
  Most recent first, capped at 200. Records what the agent actually did.
- `getChanges(threadId: string) -> { isRepo: boolean, files: ChangedFile[], touched: string[] }`
  `files` (git repos only): current working-tree changes, each with a capped
  unified diff. `touched`: project-relative paths seen in tool calls this
  thread (also for non-repos, where no diff is claimed).
- `launchRun(threadId: string, spec: { command: string, args?: string[], env?: Record<string,string> }) -> { runId: string } | { error: string }`
  Starts ONE supervised process (single-flight app-wide). `command` must be an
  absolute executable path or a binary resolvable on PATH; `args` capped at 50;
  `env` capped at 20 entries, allowlisted to `PYTHON*`, `CUDA_*`, `PATH`
  additions only — never replaces the process environment. Wall-time limit 4h.
  Only the UI calls this; the agent cannot launch runs.
- `getActiveRun() -> RunState | null`
- `getRunLogs(runId: string, opts?: { tailBytes?: number }) -> { logs: string, truncated: boolean, complete: boolean }`
  `tailBytes` capped at 256KB.
- `stopRun(runId: string) -> { ok: boolean }`
  Graceful SIGTERM to the process group, then SIGKILL. Never touches processes
  it did not start.

## Events

- `onEngineEvent(callback) -> unsubscribe`
  Event: `{ threadId, kind, ... }` where kind is one of:
  `text-delta | message | tool-start | tool-update | tool-end | settled | error`.
  `text-delta` carries `{ delta }`; `message` carries a full `Message`;
  tool events carry `{ tool, label, isError? }`;
  `error` carries `{ errorType: 'auth'|'quota'|'session'|'unknown'|'unavailable', error }`.
  Note: agent approval requests currently arrive as `error` events explaining an
  automatic decline, because dedicated approval UI is a later milestone.

## Types

```ts
interface Thread { id: string; title: string; projectPath: string; engineId: 'pi' | 'test'; createdAt: number; updatedAt: number }
interface Message { id: string; role: 'user' | 'assistant' | 'system'; text: string; createdAt: number }
interface ToolEntry { ts: number; tool: string; summary: string; isError: boolean }
interface ChangedFile { path: string; status: string; diff: string; truncated: boolean }
interface RunState { id: string; threadId: string; command: string; args: string[]; cwd: string; status: 'running' | 'exited' | 'killed' | 'timeout' | 'failed'; exitCode: number | null; startedAt: number; endedAt: number | null }
```

## Rules for the renderer

- Trust scope: the user picks any local directory as a project, and the agent
  runs with that directory as its working directory. There is no allowlist yet;
  picking sensitive directories (home, `/etc`, key stores) is possible and must
  be discouraged in onboarding copy in a later milestone.
- Never display mock metrics, runs, or GPU state. Empty states must say what is
  missing (no threads, engine unavailable, no messages yet).
- Render agent stderr/tool output as text; never as HTML. No `dangerouslySetInnerHTML`.
- Cancellation and send failures must leave truthful UI state (composer re-enabled
  with the draft preserved on failure).
