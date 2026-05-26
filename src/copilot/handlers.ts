// One-shot Copilot handler factories (R-COP-01, R-COP-02, R-COP-05..09).

import type { TaskContext, TaskHandler } from '../executor.js';
import { TaskCancelled } from '../executor.js';

import {
  extractAssistantText,
  type CopilotProvider,
  type CopilotSessionCreateOptions,
} from './provider.js';

// IMPL-DEFINED defaults (R-COP-06).
/** @category Copilot */
export const DEFAULT_COPILOT_PROMPT_MODEL = 'gpt-5-mini';
/** @category Copilot */
export const DEFAULT_COPILOT_PROMPT_TIMEOUT = 60;
/** @category Copilot */
export const DEFAULT_COPILOT_AGENT_MODEL = 'gpt-5';

/** @category Copilot */
export interface CopilotPromptHandlerOptions {
  provider: CopilotProvider;
  model?: string;
  timeout?: number | null;
  reasoningEffort?: string | null;
  workingDirectory?: string;
  sessionOptions?: Readonly<Record<string, unknown>>;
}

/** @category Copilot */
export interface CopilotAgentHandlerOptions {
  provider: CopilotProvider;
  model?: string;
  timeout?: number | null;
  reasoningEffort?: string | null;
  workingDirectory?: string;
  sessionOptions?: Readonly<Record<string, unknown>>;
}

function assertNonEmptyModel(model: string, label: string): void {
  if (typeof model !== 'string' || model.length === 0) {
    throw new TypeError(`${label}: model must be a non-empty string`);
  }
}

function assertPositiveTimeoutOrNull(timeout: number | null | undefined, label: string): void {
  if (timeout === null || timeout === undefined) return;
  if (typeof timeout !== 'number' || Number.isNaN(timeout) || timeout <= 0) {
    throw new TypeError(`${label}: timeout must be a positive number or null`);
  }
}

function effectiveTimeout(
  ctxTimeout: number | undefined,
  factoryTimeout: number | null | undefined,
): number | null {
  // R-COP-07: task timeout overrides factory; missing task timeout falls
  // back to factory default; neither => no timeout.
  if (ctxTimeout !== undefined && ctxTimeout !== null) return ctxTimeout;
  if (factoryTimeout === undefined || factoryTimeout === null) return null;
  return factoryTimeout;
}

async function runOneShot(
  provider: CopilotProvider,
  createOptions: CopilotSessionCreateOptions,
  ctx: TaskContext,
  factoryTimeout: number | null | undefined,
): Promise<string> {
  // R-COP-09: check before opening client.
  ctx.raiseIfCancelled();
  const session = await provider.createSession(createOptions);
  try {
    ctx.raiseIfCancelled();
    const timeout = effectiveTimeout(ctx.timeout, factoryTimeout);
    const response = await sendWithTimeout(session, ctx, timeout);
    ctx.raiseIfCancelled();
    return extractAssistantText(response);
  } finally {
    try {
      await session.close();
    } catch {
      /* best-effort cleanup */
    }
  }
}

async function sendWithTimeout(
  session: { sendAndWait: (p: string, o: { timeout?: number | null; signal?: AbortSignal }) => Promise<unknown>; abort?: () => Promise<void> | void },
  ctx: TaskContext,
  timeout: number | null,
): Promise<unknown> {
  const send = session.sendAndWait(ctx.payload, { timeout, signal: ctx.signal });
  if (timeout === null) return send;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        void session.abort?.();
      } catch {
        /* ignore */
      }
      reject(new TaskCancelled(`Copilot turn timed out after ${String(timeout)}s`));
    }, Math.ceil(timeout * 1000));
  });
  try {
    return await Promise.race([send, timed]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// R-COP-01, R-COP-05..09.
/** @category Copilot */
export function makeCopilotPromptHandler(options: CopilotPromptHandlerOptions): TaskHandler {
  const model = options.model ?? DEFAULT_COPILOT_PROMPT_MODEL;
  assertNonEmptyModel(model, 'makeCopilotPromptHandler');
  const timeout = options.timeout === undefined ? DEFAULT_COPILOT_PROMPT_TIMEOUT : options.timeout;
  assertPositiveTimeoutOrNull(timeout, 'makeCopilotPromptHandler');

  return async (ctx) =>
    runOneShot(
      options.provider,
      {
        model,
        tools: false,
        reasoningEffort: options.reasoningEffort ?? null,
        workingDirectory: options.workingDirectory,
        sessionOptions: options.sessionOptions,
      },
      ctx,
      timeout,
    );
}

// R-COP-02, R-COP-05..09.
/** @category Copilot */
export function makeCopilotAgentHandler(options: CopilotAgentHandlerOptions): TaskHandler {
  const model = options.model ?? DEFAULT_COPILOT_AGENT_MODEL;
  assertNonEmptyModel(model, 'makeCopilotAgentHandler');
  const timeout = options.timeout === undefined ? null : options.timeout;
  assertPositiveTimeoutOrNull(timeout, 'makeCopilotAgentHandler');

  return async (ctx) =>
    runOneShot(
      options.provider,
      {
        model,
        tools: true,
        reasoningEffort: options.reasoningEffort ?? null,
        workingDirectory: options.workingDirectory,
        sessionOptions: options.sessionOptions,
      },
      ctx,
      timeout,
    );
}
