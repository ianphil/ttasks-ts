// Copilot integration: provider abstraction. The contract treats the underlying
// LLM SDK as IMPL-DEFINED (R-COP-23). A provider creates sessions; a session
// sends one turn at a time and may be aborted/closed. Concrete provider
// implementations (Copilot CLI, OpenAI SDK, MCP, etc.) live elsewhere.

export interface CopilotSessionCreateOptions {
  model: string;
  // R-COP-01 / R-COP-02: PROMPT runs tools=false, AGENT runs tools=true.
  tools: boolean;
  reasoningEffort?: string | null;
  workingDirectory?: string;
  // Pass-through bag for provider-specific knobs (R-COP-10).
  sessionOptions?: Readonly<Record<string, unknown>>;
  // Provider events surface to this callback when supplied (R-COP-21).
  onEvent?: (event: unknown) => void;
}

export interface CopilotSendOptions {
  // null / undefined => no ttasks-imposed timeout (R-COP-07).
  timeout?: number | null;
  signal?: AbortSignal;
}

export interface CopilotProviderSession {
  // R-COP-15: returns the raw provider response; extractAssistantText
  // normalizes per R-COP-03.
  sendAndWait(prompt: string, options: CopilotSendOptions): Promise<unknown>;
  abort?(): Promise<void> | void;
  close(): Promise<void> | void;
}

export interface CopilotProvider {
  createSession(options: CopilotSessionCreateOptions): Promise<CopilotProviderSession>;
}

// R-COP-03: anything that isn't an assistant text payload normalizes to "".
export function extractAssistantText(response: unknown): string {
  if (typeof response === 'string') return response;
  if (response === null || response === undefined) return '';
  if (typeof response === 'object') {
    const r = response as Record<string, unknown>;
    if (typeof r.assistantText === 'string') return r.assistantText;
    if (typeof r.text === 'string') return r.text;
    const msg = r.message;
    if (msg && typeof msg === 'object') {
      const content = (msg as Record<string, unknown>).content;
      if (typeof content === 'string') return content;
    }
  }
  return '';
}

// --- Stub provider for tests and unconfigured environments (R-COP-23, R-COP-25) -----

export type StubResponder = (
  prompt: string,
  options: CopilotSendOptions,
) => unknown | Promise<unknown>;

export interface StubCallRecord {
  readonly model: string;
  readonly tools: boolean;
  readonly prompt: string;
  readonly timeout: number | null | undefined;
  readonly hadSignal: boolean;
}

export class StubCopilotProvider implements CopilotProvider {
  public readonly calls: StubCallRecord[] = [];
  public readonly sessionsCreated: StubCopilotSession[] = [];
  #responder: StubResponder;

  public constructor(responder: StubResponder = () => '') {
    this.#responder = responder;
  }

  public setResponder(responder: StubResponder): void {
    this.#responder = responder;
  }

  public async createSession(options: CopilotSessionCreateOptions): Promise<CopilotProviderSession> {
    const s = new StubCopilotSession(options, this.#responder, this.calls);
    this.sessionsCreated.push(s);
    return s;
  }
}

export class StubCopilotSession implements CopilotProviderSession {
  public closed = false;
  public aborts = 0;
  public readonly options: CopilotSessionCreateOptions;
  readonly #calls: StubCallRecord[];
  readonly #responder: StubResponder;
  #inFlightAbort: (() => void) | null = null;

  public constructor(
    options: CopilotSessionCreateOptions,
    responder: StubResponder,
    calls: StubCallRecord[],
  ) {
    this.options = options;
    this.#responder = responder;
    this.#calls = calls;
  }

  public async sendAndWait(prompt: string, options: CopilotSendOptions): Promise<unknown> {
    this.#calls.push({
      model: this.options.model,
      tools: this.options.tools,
      prompt,
      timeout: options.timeout,
      hadSignal: options.signal !== undefined,
    });
    if (options.signal?.aborted === true) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    const responsePromise = Promise.resolve(this.#responder(prompt, options));
    if (options.signal === undefined) return responsePromise;
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      };
      this.#inFlightAbort = onAbort;
      options.signal!.addEventListener('abort', onAbort, { once: true });
      responsePromise.then(
        (v) => {
          options.signal!.removeEventListener('abort', onAbort);
          this.#inFlightAbort = null;
          resolve(v);
        },
        (err) => {
          options.signal!.removeEventListener('abort', onAbort);
          this.#inFlightAbort = null;
          reject(err);
        },
      );
    });
  }

  public abort(): void {
    this.aborts++;
    this.#inFlightAbort?.();
  }

  public close(): void {
    this.closed = true;
  }
}
