// Long-lived multi-turn Copilot session (R-COP-10..22). The TS port collapses
// the Python sync/async distinction into a single "active" state per the
// copilot.md guidance, marking R-COP-12/R-COP-18 sync-vs-async clauses as N/A.

import type { TaskHandler } from '../executor.js';
import { TaskCancelled } from '../executor.js';

import {
  extractAssistantText,
  type CopilotProvider,
  type CopilotProviderSession,
  type CopilotSendOptions,
} from './provider.js';

export interface CopilotAgentSessionOptions {
  provider: CopilotProvider;
  model: string;
  timeout?: number | null;
  reasoningEffort?: string | null;
  workingDirectory?: string;
  sessionOptions?: Readonly<Record<string, unknown>>;
}

export type CopilotEventHandler = (event: unknown) => void;

export class CopilotAgentSession {
  readonly #provider: CopilotProvider;
  public readonly model: string;
  public readonly timeout: number | null;
  public readonly reasoningEffort: string | null;
  public readonly workingDirectory: string | undefined;
  readonly #sessionOptions: Readonly<Record<string, unknown>> | undefined;
  readonly #subscribers = new Set<CopilotEventHandler>();
  readonly #eventErrors: Error[] = [];

  #session: CopilotProviderSession | undefined;
  #active = false;
  // R-COP-16: serialization queue.
  #queue: Promise<unknown> = Promise.resolve();

  public constructor(options: CopilotAgentSessionOptions) {
    if (typeof options.model !== 'string' || options.model.length === 0) {
      throw new TypeError('CopilotAgentSession: model must be a non-empty string');
    }
    if (options.timeout !== null && options.timeout !== undefined) {
      if (typeof options.timeout !== 'number' || Number.isNaN(options.timeout) || options.timeout <= 0) {
        throw new TypeError('CopilotAgentSession: timeout must be a positive number or null');
      }
    }
    this.#provider = options.provider;
    this.model = options.model;
    this.timeout = options.timeout === undefined ? null : options.timeout;
    this.reasoningEffort = options.reasoningEffort ?? null;
    this.workingDirectory = options.workingDirectory;
    this.#sessionOptions = options.sessionOptions;
  }

  public get active(): boolean {
    return this.#active;
  }

  public get eventErrors(): readonly Error[] {
    return this.#eventErrors;
  }

  // R-COP-11: single-active lifecycle.
  public async open(): Promise<void> {
    if (this.#active) {
      throw new Error('CopilotAgentSession: already active');
    }
    let session: CopilotProviderSession;
    try {
      session = await this.#provider.createSession({
        model: this.model,
        tools: true,
        reasoningEffort: this.reasoningEffort,
        workingDirectory: this.workingDirectory,
        sessionOptions: this.#sessionOptions,
        onEvent: (event) => this.#dispatch(event),
      });
    } catch (err) {
      // R-COP-13: failed open leaves the session closed.
      this.#active = false;
      this.#session = undefined;
      throw err;
    }
    this.#session = session;
    this.#active = true;
  }

  // R-COP-14: close the provider session.
  public async close(): Promise<void> {
    if (!this.#active) return;
    const session = this.#session;
    this.#active = false;
    this.#session = undefined;
    this.#queue = Promise.resolve();
    if (session === undefined) return;
    await session.close();
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  public async abort(): Promise<void> {
    const session = this.#session;
    if (session === undefined || session.abort === undefined) return;
    await session.abort();
  }

  // R-COP-15, R-COP-16, R-COP-17.
  public async sendAndWait(
    prompt: string,
    options: CopilotSendOptions = {},
  ): Promise<string> {
    if (!this.#active || this.#session === undefined) {
      throw new Error('CopilotAgentSession: not active');
    }
    if (typeof prompt !== 'string') {
      throw new TypeError('CopilotAgentSession.sendAndWait: prompt must be a string');
    }
    if (options.timeout !== null && options.timeout !== undefined) {
      if (typeof options.timeout !== 'number' || Number.isNaN(options.timeout) || options.timeout <= 0) {
        throw new TypeError('CopilotAgentSession.sendAndWait: timeout must be a positive number or null');
      }
    }
    const effectiveTimeout =
      options.timeout === undefined ? this.timeout : options.timeout;
    const session = this.#session;
    const signal = options.signal;

    const prior = this.#queue;
    const turn = (async (): Promise<string> => {
      try {
        await prior;
      } catch {
        /* prior errors are isolated per-caller */
      }
      const response = await sendWithTimeout(session, prompt, signal, effectiveTimeout);
      return extractAssistantText(response);
    })();
    this.#queue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  // R-COP-21.
  public on(handler: CopilotEventHandler): () => void {
    if (typeof handler !== 'function') {
      throw new TypeError('CopilotAgentSession.on: handler must be a function');
    }
    this.#subscribers.add(handler);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.#subscribers.delete(handler);
    };
  }

  // R-COP-22.
  #dispatch(event: unknown): void {
    for (const sub of this.#subscribers) {
      try {
        sub(event);
      } catch (err) {
        this.#eventErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  // R-COP-19. R-COP-18 sync/async distinction is N/A in the TS port.
  public handler(): TaskHandler {
    return async (ctx) => {
      if (!this.#active) {
        throw new Error('CopilotAgentSession: session is not active');
      }
      ctx.raiseIfCancelled();
      const onAbort = (): void => {
        void this.abort();
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      try {
        const text = await this.sendAndWait(ctx.payload, {
          timeout: ctx.timeout ?? null,
          signal: ctx.signal,
        });
        ctx.raiseIfCancelled();
        return text;
      } catch (err) {
        if (ctx.cancelled) throw new TaskCancelled();
        throw err;
      } finally {
        ctx.signal.removeEventListener('abort', onAbort);
      }
    };
  }
}

async function sendWithTimeout(
  session: CopilotProviderSession,
  prompt: string,
  signal: AbortSignal | undefined,
  timeout: number | null,
): Promise<unknown> {
  const send = session.sendAndWait(prompt, { timeout, signal });
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
