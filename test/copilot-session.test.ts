import { describe, expect, it } from 'vitest';

import { TaskCancelled, TaskContext, TaskExecutor } from '../src/executor.js';
import { TaskGraph } from '../src/graph.js';
import {
  CopilotAgentSession,
  StubCopilotProvider,
  type CopilotProvider,
  type CopilotProviderSession,
  type CopilotSendOptions,
  type CopilotSessionCreateOptions,
} from '../src/copilot/index.js';
import { Task, TaskStatus, TaskType } from '../src/task.js';

function makeCtx(task: Task, controller = new AbortController()): TaskContext {
  return new TaskContext({
    task,
    signal: controller.signal,
    isCancelled: () => controller.signal.aborted,
  });
}

describe('CopilotAgentSession — R-COP-10 construction validation', () => {
  it('rejects empty model', () => {
    const provider = new StubCopilotProvider();
    expect(() => new CopilotAgentSession({ provider, model: '' })).toThrow(TypeError);
  });

  it('rejects non-positive timeout', () => {
    const provider = new StubCopilotProvider();
    expect(() => new CopilotAgentSession({ provider, model: 'm', timeout: 0 })).toThrow(TypeError);
    expect(() => new CopilotAgentSession({ provider, model: 'm', timeout: -3 })).toThrow(TypeError);
  });

  it('accepts sessionOptions pass-through', async () => {
    const provider = new StubCopilotProvider(() => 'ok');
    const s = new CopilotAgentSession({
      provider,
      model: 'gpt-5',
      sessionOptions: { temperature: 0.4 },
    });
    await s.open();
    expect(provider.sessionsCreated[0]!.options.sessionOptions).toEqual({ temperature: 0.4 });
    await s.close();
  });
});

describe('CopilotAgentSession — R-COP-11 single-active lifecycle', () => {
  it('rejects double-open', async () => {
    const provider = new StubCopilotProvider();
    const s = new CopilotAgentSession({ provider, model: 'gpt-5' });
    await s.open();
    await expect(s.open()).rejects.toThrow(/already active/);
    await s.close();
  });

  it('re-openable after close', async () => {
    const provider = new StubCopilotProvider();
    const s = new CopilotAgentSession({ provider, model: 'gpt-5' });
    await s.open();
    await s.close();
    await s.open();
    expect(s.active).toBe(true);
    await s.close();
  });
});

describe('CopilotAgentSession — R-COP-13 enter failure cleans up', () => {
  it('leaves session closed if provider.createSession throws', async () => {
    const provider: CopilotProvider = {
      createSession: async () => {
        throw new Error('create failed');
      },
    };
    const s = new CopilotAgentSession({ provider, model: 'gpt-5' });
    await expect(s.open()).rejects.toThrow('create failed');
    expect(s.active).toBe(false);
  });
});

describe('CopilotAgentSession — R-COP-14 close closes session', () => {
  it('close() awaits the underlying session close', async () => {
    const provider = new StubCopilotProvider();
    const s = new CopilotAgentSession({ provider, model: 'gpt-5' });
    await s.open();
    const provSess = provider.sessionsCreated[0]!;
    await s.close();
    expect(provSess.closed).toBe(true);
    expect(s.active).toBe(false);
  });

  it('surfaces close errors', async () => {
    const provider: CopilotProvider = {
      createSession: async () => ({
        sendAndWait: async () => '',
        close: () => {
          throw new Error('close exploded');
        },
      }),
    };
    const s = new CopilotAgentSession({ provider, model: 'gpt-5' });
    await s.open();
    await expect(s.close()).rejects.toThrow('close exploded');
  });
});

describe('CopilotAgentSession — R-COP-15 sendAndWait', () => {
  it('rejects when session is not active', async () => {
    const provider = new StubCopilotProvider();
    const s = new CopilotAgentSession({ provider, model: 'gpt-5' });
    await expect(s.sendAndWait('hi')).rejects.toThrow(/not active/);
  });

  it('rejects non-string prompt', async () => {
    const provider = new StubCopilotProvider();
    const s = new CopilotAgentSession({ provider, model: 'gpt-5' });
    await s.open();
    await expect(s.sendAndWait(42 as unknown as string)).rejects.toThrow(TypeError);
    await s.close();
  });

  it('rejects non-positive timeout', async () => {
    const provider = new StubCopilotProvider();
    const s = new CopilotAgentSession({ provider, model: 'gpt-5' });
    await s.open();
    await expect(s.sendAndWait('hi', { timeout: 0 })).rejects.toThrow(TypeError);
    await s.close();
  });

  it('uses per-call timeout when supplied', async () => {
    const provider = new StubCopilotProvider(() => 'ok');
    const s = new CopilotAgentSession({ provider, model: 'gpt-5', timeout: 30 });
    await s.open();
    await s.sendAndWait('hi', { timeout: 5 });
    expect(provider.calls[0]!.timeout).toBe(5);
    await s.close();
  });

  it('falls back to session default when per-call timeout omitted', async () => {
    const provider = new StubCopilotProvider(() => 'ok');
    const s = new CopilotAgentSession({ provider, model: 'gpt-5', timeout: 30 });
    await s.open();
    await s.sendAndWait('hi');
    expect(provider.calls[0]!.timeout).toBe(30);
    await s.close();
  });
});

describe('CopilotAgentSession — R-COP-16 serialization', () => {
  it('serializes concurrent turns in submission order', async () => {
    const order: string[] = [];
    const provider: CopilotProvider = {
      createSession: async () => ({
        sendAndWait: async (prompt: string) => {
          order.push(`start:${prompt}`);
          await new Promise((r) => setTimeout(r, 20));
          order.push(`end:${prompt}`);
          return prompt;
        },
        close: () => {},
      }),
    };
    const s = new CopilotAgentSession({ provider, model: 'gpt-5' });
    await s.open();
    const a = s.sendAndWait('A');
    const b = s.sendAndWait('B');
    const c = s.sendAndWait('C');
    await Promise.all([a, b, c]);
    expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B', 'start:C', 'end:C']);
    await s.close();
  });
});

describe('CopilotAgentSession — R-COP-17 conversation continuity', () => {
  it('reuses one underlying SDK session across turns', async () => {
    const provider = new StubCopilotProvider(() => 'reply');
    const s = new CopilotAgentSession({ provider, model: 'gpt-5' });
    await s.open();
    await s.sendAndWait('one');
    await s.sendAndWait('two');
    expect(provider.sessionsCreated).toHaveLength(1);
    await s.close();
  });

  it('open after close starts a fresh provider session', async () => {
    const provider = new StubCopilotProvider(() => 'reply');
    const s = new CopilotAgentSession({ provider, model: 'gpt-5' });
    await s.open();
    await s.sendAndWait('one');
    await s.close();
    await s.open();
    await s.sendAndWait('two');
    expect(provider.sessionsCreated).toHaveLength(2);
    await s.close();
  });
});

describe('CopilotAgentSession — handler integration (R-COP-18/19/20)', () => {
  it('R-COP-18: handler throws when session is not active', async () => {
    const provider = new StubCopilotProvider();
    const s = new CopilotAgentSession({ provider, model: 'gpt-5' });
    const h = s.handler();
    await expect(h(makeCtx(Task.agent('hi')))).rejects.toThrow(/not active/);
  });

  it('R-COP-19: handler returns assistant text on success', async () => {
    const provider = new StubCopilotProvider(() => 'session reply');
    const s = new CopilotAgentSession({ provider, model: 'gpt-5' });
    await s.open();
    const out = (await s.handler()(makeCtx(Task.agent('hi')))) as string;
    expect(out).toBe('session reply');
    await s.close();
  });

  it('R-COP-19: handler is registerable on the executor', async () => {
    const provider = new StubCopilotProvider(() => 'ok');
    const s = new CopilotAgentSession({ provider, model: 'gpt-5' });
    await s.open();
    const exec = new TaskExecutor();
    exec.register(TaskType.AGENT, s.handler());
    const t = Task.agent('run');
    const result = await exec.execute(t);
    expect(t.status).toBe(TaskStatus.SUCCEEDED);
    expect(result.output).toBe('ok');
    await s.close();
  });

  it('R-COP-20: cancellation aborts the in-flight turn and session remains usable', async () => {
    let resolveTurn: (v: string) => void = () => {};
    let calls = 0;
    const provider: CopilotProvider = {
      createSession: async (_opts: CopilotSessionCreateOptions): Promise<CopilotProviderSession> => {
        let abortListener: (() => void) | null = null;
        return {
          sendAndWait: async (_prompt: string, sendOpts: CopilotSendOptions) => {
            calls++;
            if (calls === 1) {
              return new Promise<string>((_resolve, reject) => {
                const onAbort = (): void => {
                  const e = new Error('aborted');
                  e.name = 'AbortError';
                  reject(e);
                };
                abortListener = onAbort;
                sendOpts.signal?.addEventListener('abort', onAbort, { once: true });
              });
            }
            return new Promise<string>((resolve) => {
              resolveTurn = resolve;
            });
          },
          abort: () => {
            abortListener?.();
          },
          close: () => {},
        };
      },
    };
    const s = new CopilotAgentSession({ provider, model: 'gpt-5' });
    await s.open();
    const h = s.handler();
    const ctrl = new AbortController();
    const t = Task.agent('long');
    const ctx = makeCtx(t, ctrl);
    const turn1 = h(ctx);
    setTimeout(() => ctrl.abort(), 5);
    await expect(turn1).rejects.toBeInstanceOf(TaskCancelled);

    // Session still usable.
    const ctrl2 = new AbortController();
    const turn2 = h(makeCtx(Task.agent('after'), ctrl2));
    // Wait for the second sendAndWait to register resolveTurn.
    for (let i = 0; i < 50 && calls < 2; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 5));
    resolveTurn('ok2');
    expect(await turn2).toBe('ok2');
    await s.close();
  });
});

describe('CopilotAgentSession — R-COP-21/22 events', () => {
  it('on() rejects non-callable', () => {
    const provider = new StubCopilotProvider();
    const s = new CopilotAgentSession({ provider, model: 'gpt-5' });
    expect(() => s.on(42 as unknown as () => void)).toThrow(TypeError);
  });

  it('on() returns idempotent unsubscribe', async () => {
    const events: unknown[] = [];
    let emit: ((e: unknown) => void) | undefined;
    const provider: CopilotProvider = {
      createSession: async (opts) => {
        emit = opts.onEvent;
        return {
          sendAndWait: async () => 'ok',
          close: () => {},
        };
      },
    };
    const s = new CopilotAgentSession({ provider, model: 'gpt-5' });
    await s.open();
    const unsub = s.on((e) => events.push(e));
    emit!({ tag: 1 });
    unsub();
    unsub(); // idempotent
    emit!({ tag: 2 });
    expect(events).toEqual([{ tag: 1 }]);
    await s.close();
  });

  it('R-COP-22: subscriber errors are isolated into eventErrors', async () => {
    const seen: unknown[] = [];
    let emit: ((e: unknown) => void) | undefined;
    const provider: CopilotProvider = {
      createSession: async (opts) => {
        emit = opts.onEvent;
        return {
          sendAndWait: async () => 'ok',
          close: () => {},
        };
      },
    };
    const s = new CopilotAgentSession({ provider, model: 'gpt-5' });
    await s.open();
    s.on(() => {
      throw new Error('bad subscriber');
    });
    s.on((e) => seen.push(e));
    emit!({ tag: 1 });
    emit!({ tag: 2 });
    expect(seen).toEqual([{ tag: 1 }, { tag: 2 }]);
    expect(s.eventErrors).toHaveLength(2);
    expect(s.eventErrors[0]!.message).toBe('bad subscriber');
    await s.close();
  });
});

describe('CopilotAgentSession — graph integration', () => {
  it('shared session backs multiple AGENT tasks in a graph', async () => {
    const seen: string[] = [];
    const provider: CopilotProvider = {
      createSession: async () => ({
        sendAndWait: async (prompt: string) => {
          seen.push(prompt);
          return `reply:${prompt}`;
        },
        close: () => {},
      }),
    };
    const s = new CopilotAgentSession({ provider, model: 'gpt-5' });
    await s.open();
    const exec = new TaskExecutor();
    exec.register(TaskType.AGENT, s.handler());
    const t1 = Task.agent('p1');
    const t2 = Task.agent('p2');
    const g = new TaskGraph();
    g.add(t1);
    g.add(t2, { after: [t1] });
    await g.run(exec);
    expect(t1.status).toBe(TaskStatus.SUCCEEDED);
    expect(t2.status).toBe(TaskStatus.SUCCEEDED);
    expect(t1.result!.output).toBe('reply:p1');
    expect(t2.result!.output).toBe('reply:p2');
    expect(seen).toEqual(['p1', 'p2']);
    expect(provider).toBeDefined();
    await s.close();
  });
});
