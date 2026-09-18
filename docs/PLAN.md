# ML Copilot implementation plan

## Agreed direction

Thread (design 01), Electron, Linux first, Pi first behind a replaceable engine boundary. Existing local projects; Git is not required. User-managed Pi authentication. Scoped autonomy is the eventual goal, not a property of an unverified integration.

## Working rules

- Preserve all design studies. Their replies, curves and controls are mock data, never live features.
- Keep the renderer sandboxed, context-isolated and without Node access. Validate privileged IPC and its sender; never expose a generic command runner.
- Do not silently install engines globally, access credentials, launch training, or publish the repository.
- One coherent milestone at a time: implement, test, independent review, fix, rerun, checkpoint.
- Delegate independent files to general agents; use background agents for engine/process integration and separate review. Do not share file ownership concurrently.
- Use pinned dependencies and a lockfile. Record real test results and limitations.

## Milestone 0 — runnable design shell

Load the selected Thread prototype inside Electron with a persistent visible prototype notice. No agent connection or privileges exposed to the prototype. Block remote navigation and new windows, deny browser permissions, restrict local resource requests. Add a desktop smoke test and verify sandbox settings.

Acceptance: npm start opens the Thread design; native runtime reports its version over a narrow preload bridge; tests verify window creation, UI, mock interaction, and blocked navigation. This is a packaging milestone, NOT a functional agent product.

## Milestone 1 — verify Pi, establish adapter

Inspect a locally pinned Pi distribution and its matching documentation, not just the changing main branch. Spike strict LF-delimited RPC framing, version/state discovery, prompt events, failures, abort and session recovery. Disable automatically loaded extensions where supported. Do not start provider calls without configured authentication.

Use one interface for capability reporting, lifecycle, message events, cancellation and error states. App-owned thread IDs link to engine-native sessions; do not promise session portability between engines. Test with a protocol fixture but distinguish that from a live authenticated run.

Gate: independent review of lifecycle, protocol framing and permission claims. Pi tool hooks are not an OS sandbox. Until constraints are verified, do not enable autonomous shell/edit execution. No offensive testing against external targets.

## Milestone 2 — actual Thread workspace

Replace the mock renderer with React + TypeScript components based on Thread visual tokens. Project picker, persistent threads, composer, streaming messages, activity, engine state and cancellation. Fonts/assets bundled locally. Explicit empty/error states; no fake GPU or experiment cards. Isolate renderer, preload, shared contracts, engine adapter and persistence modules.

Acceptance: project association and threads survive restart; message streams are correlated to their originating thread; cancellation and crashes terminate busy states; renderer reload does not duplicate submissions. Errors never become canned success replies.

## Milestone 3 — permissions and real changes

Implement only controls enforceable by the engine or app execution boundary. Distinguish proposed versus already-applied edits. Preserve concurrent user changes. Read-only inspection initially if scoped execution cannot be established. Explicit trust/privacy disclosure before project content is sent to a provider.

Acceptance: denial prevents the actual action; stale approvals are invalidated; cancellation and quit clean up owned processes; untrusted rendered output cannot invoke privileged IPC. Independent code review before execution enabled.

## Milestone 4 — researcher pilot

Linux launch/package instructions, engine onboarding, end-to-end tests with a small local PyTorch repository, real provider smoke test when credentials are available, recovery and failure tests. Release bar: open project, use Pi for an actual task, see truthful changes/activity, reopen conversation.

## Later, not initial scope

Training supervision, TensorBoard/GPU telemetry, dataset/checkpoint tools, multiple real engine adapters, remote compute, notebooks, sweeps. Do not create empty subsystems for these now.

## Current checks

- Node 22.23.2 and npm 10.9.8 available.
- DISPLAY is set to :1; `npm run test:desktop` passes in this environment.
- Pi 0.73.1 pinned locally (`node_modules/.bin/pi`); `pi --mode rpc --no-session`
  starts cleanly and `get_state` confirms no session persistence.
- Provider: OpenRouter (`OPENROUTER_API_KEY` env only, never committed) with
  `~/.pi/agent/settings.json` setting default model
  `openrouter/nex-agi/nex-n2.5-mini:free` (verified live; also registered
  `openrouter/deepseek/deepseek-v4-flash-0731` — note the `:free` suffixed
  DeepSeek slug does not exist).
  Live RPC prompts return streamed text successfully. The app reads an optional
  `MLCOPILOT_MODEL` env override; otherwise Pi uses its configured default.
- Full-review findings fixed: per-thread Pi sessions via `--session-dir` (HOME is
  inherited so Pi reads the user's real settings/auth — overriding HOME silently
  changed the active model); run finalization on `agent_end` with `willRetry=false`
  (Pi 0.73.1 RPC does not reliably emit `agent_settled`); empty model replies
  surface an honest error; dead prototype host files removed; `test:e2e` script
  added; single-instance lock in main.
- Live end-to-end through the real app (OpenRouter nex-mini): prompt accepted,
  exact reply streamed, persisted, and settled.
- Milestone 3 (change visibility + trust): per-project trust gate with provider
  disclosure; persisted tool-activity log with bounded records; git change
  inspection (NUL-delimited porcelain, renames resolved, diff vs HEAD so staged
  changes appear); non-repos report touched paths with no diff claims; trust
  file quarantine + atomic writes; single-instance lock.
- Unauthenticated `prompt` is rejected with a missing-API-key error; the adapter
  surfaces this as `{ ok: false, errorType: 'auth' }`. `abort` succeeds; strict
  LF JSONL framing parses with zero unparseable lines (`tests/pi-rpc-spike.cjs`,
  `tests/pi-adapter.test.cjs`).
- Git origin: https://github.com/shasank0001/exp.git.
