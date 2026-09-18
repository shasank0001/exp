# Engine bridge contract (preload `window.mlcopilot`)

Version 0.1 — Milestone 2. The renderer is sandboxed with no Node access; all
privileged work goes through these IPC methods. The renderer must not assume
any other global.

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
- `getEngineState() -> { available: boolean, version?: string, error?: string }`
  `available=false` when the Pi binary is missing or fails to start; the
  renderer shows this honestly and disables sending.

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
