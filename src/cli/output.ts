// src/cli/output.ts

import type { OutputEvent, ResultEvent, ErrorEvent, WarningEvent, ChangeEvent, ProgressEvent, InfoEvent, PromptEvent } from './types.js';
import { ExitCode, errorCodeToExitCode, type ExitCodeValue } from './exit-codes.js';

export interface OutputOptions {
  json: boolean;
  noColor: boolean;
}

/**
 * Output controller that handles both JSONL and text output modes.
 * All CLI output should go through this class.
 */
export class Output {
  private options: OutputOptions;
  private commandName: string = '';
  private events: OutputEvent[] = [];

  constructor(options: OutputOptions) {
    this.options = options;
  }

  setCommand(name: string): void {
    this.commandName = name;
  }

  /**
   * Emit a progress event.
   */
  progress(phase: string, message: string, pct?: number): void {
    const event: ProgressEvent = { type: 'progress', phase, message, ...(pct !== undefined && { pct }) };
    this.emit(event);
  }

  /**
   * Emit an info event.
   */
  info(message: string, data?: Record<string, unknown>): void {
    const event: InfoEvent = { type: 'info', message, ...(data && { data }) };
    this.emit(event);
  }

  /**
   * Emit a change event.
   */
  change(
    op: ChangeEvent['op'],
    entity: ChangeEvent['entity'],
    name: string,
    opts?: { before?: string; after?: string; target?: string }
  ): void {
    const event: ChangeEvent = { type: 'change', op, entity, name, ...opts };
    this.emit(event);
  }

  /**
   * Emit a warning event.
   */
  warning(code: string, message: string, opts?: { path?: string; hint?: string }): void {
    const event: WarningEvent = { type: 'warning', code, message, ...opts };
    this.emit(event);
  }

  /**
   * Emit a prompt event (for AI agent consumption).
   * In text mode, this is typically handled by @inquirer/prompts directly.
   */
  prompt(code: string, question: string, options: string[], defaultOption?: string): void {
    const event: PromptEvent = {
      type: 'prompt',
      code,
      question,
      options,
      ...(defaultOption !== undefined && { default: defaultOption })
    };
    this.emit(event);
  }

  /**
   * Emit an error event and return the appropriate exit code.
   */
  error(code: string, message: string, opts?: { path?: string; hint?: string; cause?: string }): ExitCodeValue {
    const event: ErrorEvent = { type: 'error', code, message, ...opts };
    this.emit(event);
    return errorCodeToExitCode(code);
  }

  /**
   * Emit the final result event.
   * This should be called exactly once at the end of each command.
   */
  result(ok: boolean, summary: ResultEvent['summary']): void {
    const event: ResultEvent = {
      type: 'result',
      command: this.commandName,
      ok,
      data_schema_version: 1,
      summary,
    };
    this.emit(event);
  }

  /**
   * Get all emitted events (for testing).
   */
  getEvents(): OutputEvent[] {
    return [...this.events];
  }

  private emit(event: OutputEvent): void {
    this.events.push(event);

    if (this.options.json) {
      this.emitJson(event);
    } else {
      this.emitText(event);
    }
  }

  private emitJson(event: OutputEvent): void {
    // In JSON mode, all events go to stdout (§11.9)
    console.log(JSON.stringify(event));
  }

  private emitText(event: OutputEvent): void {
    switch (event.type) {
      case 'progress':
        console.log(event.message);
        break;
      case 'info':
        console.log(event.message);
        break;
      case 'change':
        console.log(this.formatChange(event));
        break;
      case 'warning':
        console.error(`⚠ ${event.message}`);
        if (event.hint) console.error(`  Hint: ${event.hint}`);
        break;
      case 'error':
        console.error(`✗ ${event.message}`);
        if (event.hint) console.error(`  ${event.hint}`);
        break;
      case 'result':
        // Result is typically implicit in text mode, summary already printed
        break;
      case 'prompt':
        // Prompt events are typically handled by @inquirer/prompts in text mode
        // But we still need to handle them for completeness
        console.log(`? ${event.question}`);
        break;
    }
  }

  private formatChange(event: ChangeEvent): string {
    const symbols: Record<ChangeEvent['op'], string> = {
      add: '+',
      modify: '~',
      delete: '-',
      link: '→',
      unlink: '⊗',
      push: '↑',
      pull: '↓',
      resolve: '✓',
      restore: '↺',
      stash: '⊟',
      backup: '⊞',
    };
    const symbol = symbols[event.op] || '•';
    let line = `${symbol} ${event.name}`;
    if (event.target) line += ` → ${event.target}`;
    return line;
  }
}

/**
 * Create a new Output instance with the given options.
 */
export function createOutput(options: OutputOptions): Output {
  return new Output(options);
}

/**
 * Global output instance for convenience.
 * Initialize with setGlobalOutput() before using.
 */
let globalOutput: Output | null = null;

export function setGlobalOutput(output: Output): void {
  globalOutput = output;
}

export function getGlobalOutput(): Output {
  if (!globalOutput) {
    throw new Error('Global output not initialized. Call setGlobalOutput() first.');
  }
  return globalOutput;
}
