// src/cli/types.ts

/**
 * JSONL event types for --json mode output.
 * See spec §11.2 for protocol details.
 */

export interface ProgressEvent {
  type: 'progress';
  phase: string;
  message: string;
  pct?: number;
}

export interface InfoEvent {
  type: 'info';
  message: string;
  data?: Record<string, unknown>;
}

export interface ChangeEvent {
  type: 'change';
  op: 'add' | 'modify' | 'delete' | 'link' | 'unlink' | 'push' | 'pull' | 'resolve' | 'restore' | 'stash' | 'backup';
  entity: 'skill' | 'source' | 'agent' | 'server' | 'link' | 'manifest' | 'registry';
  name: string;
  before?: string;
  after?: string;
  target?: string;
}

export interface WarningEvent {
  type: 'warning';
  code: string;
  message: string;
  path?: string;
  hint?: string;
}

export interface ErrorEvent {
  type: 'error';
  code: string;
  message: string;
  path?: string;
  hint?: string;
  cause?: string;
}

export interface PromptEvent {
  type: 'prompt';
  code: string;
  question: string;
  options: string[];
  default?: string;
}

export interface ResultEvent {
  type: 'result';
  command: string;
  ok: boolean;
  summary: {
    [key: string]: unknown;
    data?: Record<string, unknown>;
  };
}

export type OutputEvent =
  | ProgressEvent
  | InfoEvent
  | ChangeEvent
  | WarningEvent
  | ErrorEvent
  | PromptEvent
  | ResultEvent;
