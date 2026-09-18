/** Shared renderer-side types mirroring docs/ENGINE_BRIDGE.md v0.2. */

export interface Thread {
  id: string;
  title: string;
  projectPath: string;
  engineId: 'pi' | 'test';
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: number;
}

export interface EngineState {
  available: boolean;
  version?: string;
  provider?: string;
  error?: string;
}

export interface ToolEntry {
  ts: number;
  tool: string;
  summary: string;
  isError: boolean;
}

export interface ChangedFile {
  path: string;
  status: string;
  diff: string;
  truncated: boolean;
}

export interface ChangesResult {
  isRepo: boolean;
  files: ChangedFile[];
  touched: string[];
}

export type EngineErrorType = 'auth' | 'quota' | 'session' | 'unknown' | 'unavailable';

export type EngineEvent =
  | { threadId: string; kind: 'text-delta'; delta: string }
  | { threadId: string; kind: 'message'; message: Message }
  | { threadId: string; kind: 'tool-start'; tool?: string; label?: string; isError?: boolean }
  | { threadId: string; kind: 'tool-update'; tool?: string; label?: string; isError?: boolean }
  | { threadId: string; kind: 'tool-end'; tool?: string; label?: string; isError?: boolean }
  | { threadId: string; kind: 'settled' }
  | { threadId: string; kind: 'error'; errorType: EngineErrorType; error: string };
