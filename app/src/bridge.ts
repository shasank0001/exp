import type { MlCopilotBridge } from '../bridge';

/** Safe accessor: returns the bridge or undefined when unavailable (e.g. plain browser dev). */
export function getBridge(): MlCopilotBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.mlcopilot;
}

export function hasBridge(): boolean {
  return getBridge() !== undefined;
}
