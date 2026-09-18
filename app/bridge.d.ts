import type { EngineEvent, EngineState, Message, Thread } from './src/types';

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
  onEngineEvent(callback: (event: EngineEvent) => void): () => void;
}

declare global {
  interface Window {
    mlcopilot?: MlCopilotBridge;
  }
}

export type { MlCopilotBridge };
