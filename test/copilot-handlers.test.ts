import { describe, expect, it, vi } from 'vitest';

import { TaskCancelled, TaskContext, TaskExecutor } from '../src/executor.js';
import {
  StubCopilotProvider,
  makeCopilotAgentHandler,
  makeCopilotPromptHandler,
} from '../src/copilot/index.js';
import { Task, TaskStatus, TaskType } from '../src/task.js';

function makeCtx(task: Task, controller = new AbortController()): TaskContext {
  return new TaskContext({
    task,
    signal: controller.signal,
    isCancelled: () => controller.signal.aborted,
  });
}

describe('makeCopilotPromptHandler — R-COP-05 validation', () => {
  it('rejects empty model', () => {
    const provider = new StubCopilotProvider();
    expect(() => makeCopilotPromptHandler({ provider, model: '' })).toThrow(TypeError);
  });

  it('rejects non-positive timeout', () => {
    const provider = new StubCopilotProvider();
    expect(() => makeCopilotPromptHandler({ provider, timeout: 0 })).toThrow(TypeError);
    expect(() => makeCopilotPromptHandler({ provider, timeout: -1 })).toThrow(TypeError);
    expect(() => makeCopilotPromptHandler({ provider, timeout: Number.NaN })).toThrow(TypeError);
  });

  it('accepts null timeout for no default', () => {
    const provider = new StubCopilotProvider();
    expect(() => makeCopilotPromptHandler({ provider, timeout: null })).not.toThrow();
  });
});

describe('makeCopilotAgentHandler — R-COP-05 validation', () => {
  it('rejects empty model', () => {
    const provider = new StubCopilotProvider();
    expect(() => makeCopilotAgentHandler({ provider, model: '' })).toThrow(TypeError);
  });
});

describe('PROMPT handler — R-COP-01 single-turn tool-less', () => {
  it('sends one turn with tools=false and returns assistant text', async () => {
    const provider = new StubCopilotProvider(() => 'hello');
    const handler = makeCopilotPromptHandler({ provider });
    const task = Task.prompt('greet me');
    const out = (await handler(makeCtx(task))) as string;
    expect(out).toBe('hello');
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.tools).toBe(false);
    expect(provider.calls[0]!.prompt).toBe('greet me');
    // session closed after one-shot.
    expect(provider.sessionsCreated[0]!.closed).toBe(true);
  });
});

describe('AGENT handler — R-COP-02 single-turn tool-enabled', () => {
  it('sends one turn with tools=true', async () => {
    const provider = new StubCopilotProvider(() => 'agent reply');
    const handler = makeCopilotAgentHandler({ provider });
    const task = Task.agent('do the thing');
    const out = (await handler(makeCtx(task))) as string;
    expect(out).toBe('agent reply');
    expect(provider.calls[0]!.tools).toBe(true);
  });

  it('uses a fresh session per execution (R-COP-02)', async () => {
    const provider = new StubCopilotProvider(() => 'x');
    const handler = makeCopilotAgentHandler({ provider });
    await handler(makeCtx(Task.agent('a')));
    await handler(makeCtx(Task.agent('b')));
    expect(provider.sessionsCreated).toHaveLength(2);
    expect(provider.sessionsCreated[0]).not.toBe(provider.sessionsCreated[1]);
  });
});

describe('R-COP-03 — empty / non-text responses normalize to ""', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['number', 42],
    ['empty object', {}],
    ['unknown shape', { weird: 'shape' }],
  ])('returns "" for %s', async (_label, value) => {
    const provider = new StubCopilotProvider(() => value);
    const handler = makeCopilotPromptHandler({ provider });
    const out = (await handler(makeCtx(Task.prompt('hi')))) as string;
    expect(out).toBe('');
  });

  it('extracts from { text } shape', async () => {
    const provider = new StubCopilotProvider(() => ({ text: 'shaped' }));
    const handler = makeCopilotPromptHandler({ provider });
    expect(await handler(makeCtx(Task.prompt('hi')))).toBe('shaped');
  });
});

describe('R-COP-04 — provider errors propagate', () => {
  it('rejects with the original provider error', async () => {
    const provider = new StubCopilotProvider(() => {
      throw new Error('boom from provider');
    });
    const handler = makeCopilotPromptHandler({ provider });
    await expect(handler(makeCtx(Task.prompt('hi')))).rejects.toThrow('boom from provider');
  });

  it('failure inside the executor marks task FAILED', async () => {
    const provider = new StubCopilotProvider(() => {
      throw new Error('sdk fail');
    });
    const exec = new TaskExecutor();
    exec.register(TaskType.PROMPT, makeCopilotPromptHandler({ provider }));
    const t = Task.prompt('hi');
    await expect(exec.execute(t)).rejects.toBeDefined();
    expect(t.status).toBe(TaskStatus.FAILED);
    expect(t.error).toContain('sdk fail');
  });
});

describe('R-COP-07 — task timeout overrides factory default', () => {
  it('forwards task timeout, not factory default', async () => {
    const provider = new StubCopilotProvider(() => 'ok');
    const handler = makeCopilotPromptHandler({ provider, timeout: 60 });
    const t = new Task(TaskType.PROMPT, 'hi', { timeout: 2.5 });
    await handler(makeCtx(t));
    expect(provider.calls[0]!.timeout).toBe(2.5);
  });

  it('falls back to factory default when task has no timeout', async () => {
    const provider = new StubCopilotProvider(() => 'ok');
    const handler = makeCopilotPromptHandler({ provider, timeout: 30 });
    await handler(makeCtx(Task.prompt('hi')));
    expect(provider.calls[0]!.timeout).toBe(30);
  });

  it('no timeout when both task and factory are null', async () => {
    const provider = new StubCopilotProvider(() => 'ok');
    const handler = makeCopilotAgentHandler({ provider }); // default timeout=null
    await handler(makeCtx(Task.agent('hi')));
    expect(provider.calls[0]!.timeout).toBeNull();
  });
});

describe('R-COP-08 — model override', () => {
  it('uses the model passed to the factory', async () => {
    const provider = new StubCopilotProvider(() => 'ok');
    const handler = makeCopilotPromptHandler({ provider, model: 'custom-model' });
    await handler(makeCtx(Task.prompt('hi')));
    expect(provider.calls[0]!.model).toBe('custom-model');
  });
});

describe('R-COP-09 — cancellation', () => {
  it('raises before opening client when already cancelled', async () => {
    const provider = new StubCopilotProvider(() => 'ok');
    const handler = makeCopilotPromptHandler({ provider });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(handler(makeCtx(Task.prompt('hi'), ctrl))).rejects.toBeInstanceOf(TaskCancelled);
    expect(provider.sessionsCreated).toHaveLength(0);
  });

  it('aborts an in-flight turn via signal', async () => {
    const provider = new StubCopilotProvider(
      () => new Promise(() => {}),
    );
    const handler = makeCopilotAgentHandler({ provider });
    const ctrl = new AbortController();
    const ctx = makeCtx(Task.agent('hi'), ctrl);
    const promise = handler(ctx);
    setTimeout(() => ctrl.abort(), 10);
    await expect(promise).rejects.toBeDefined();
  });

  it('raises TaskCancelled when timeout fires', async () => {
    const provider = new StubCopilotProvider(
      () => new Promise(() => {}),
    );
    const handler = makeCopilotPromptHandler({ provider, timeout: 0.05 });
    await expect(handler(makeCtx(Task.prompt('hi')))).rejects.toBeInstanceOf(TaskCancelled);
  });
});

describe('Session options pass through', () => {
  it('forwards reasoningEffort, workingDirectory, sessionOptions', async () => {
    const provider = new StubCopilotProvider(() => 'ok');
    const handler = makeCopilotPromptHandler({
      provider,
      reasoningEffort: 'high',
      workingDirectory: '/tmp/work',
      sessionOptions: { temperature: 0.2 },
    });
    await handler(makeCtx(Task.prompt('hi')));
    const opts = provider.sessionsCreated[0]!.options;
    expect(opts.reasoningEffort).toBe('high');
    expect(opts.workingDirectory).toBe('/tmp/work');
    expect(opts.sessionOptions).toEqual({ temperature: 0.2 });
  });
});

describe('R-COP-25 — optional Copilot integration', () => {
  it('Task.prompt constructs without a handler', () => {
    const t = Task.prompt('hi');
    expect(t.type).toBe(TaskType.PROMPT);
    expect(t.payload).toBe('hi');
  });

  it('execute without a registered PROMPT handler fails via R-EXEC-06', async () => {
    const exec = new TaskExecutor();
    const t = Task.prompt('hi');
    await expect(exec.execute(t)).rejects.toBeDefined();
    expect(t.status).toBe(TaskStatus.FAILED);
    expect(t.result!.terminationReason).toBe('handler');
  });
});

// Silence vitest unused warnings.
void vi;
