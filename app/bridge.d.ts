import type { ChangesResult, EngineEvent, EngineState, LaunchRunResult, Message, RunLaunchSpec, RunLogsResult, RunState, Thread, ToolEntry } from './src/types';

/** Preload-exposed engine bridge. All methods return promises. No Node access. */
interface MlCopilotBridge {
  runtimeInfo(): Promise<{ electron: string; platform: string; mode: string }>;
  pickProject(): Promise<{ path: string } | { cancelled: true }>;
  listThreads(): Promise<Thread[]>;
  createThread(args: { title: string; projectPath: string }): Promise<Thread>;
  getMessages(threadId: string): Promise<Message[]>;
  sendPrompt(threadId: string, text: string): Promise<{ accepted: boolean; error?: string }>;
  abortThread(threadId: string): Promise<{ ok: boolean }>;
  getEngineState(): Promise<EngineState>;
  getTrust(projectPath: string): Promise<{ trusted: boolean }>;
  setTrust(projectPath: string, trusted: boolean): Promise<{ trusted: boolean }>;
  getToolActivity(threadId: string): Promise<ToolEntry[]>;
  getChanges(threadId: string): Promise<ChangesResult>;
  launchRun(threadId: string, spec: RunLaunchSpec): Promise<LaunchRunResult>;
  getActiveRun(): Promise<RunState | null>;
  getRunLogs(runId: string, opts?: { tailBytes?: number }): Promise<RunLogsResult>;
  stopRun(runId: string): Promise<{ ok: boolean }>;
  onEngineEvent(callback: (event: EngineEvent) => void): () => void;
}

declare global {
  interface Window {
    mlcopilot?: MlCopilotBridge;
  }
}

export type { MlCopilotBridge };
