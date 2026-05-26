import { describe, expect, it } from 'vitest';

import { TaskEventType, type TaskEvent } from '../src/events.js';
import {
  ExecutorShutdownError,
  MissingHandlerError,
  RetryPolicy,
  TaskCancelled,
  TaskExecutionError,
  TaskExecutor,
  type TaskContext,
} from '../src/executor.js';
import { InMemoryStore, type Store } from '../src/store.js';
import { Task, TaskStatus, TaskType } from '../src/task.js';

function record(executor: TaskExecutor): TaskEvent[] {
  const events: TaskEvent[] = [];
  executor.events.subscribe((e) => events.push(e));
  return events;
}

describe('TaskExecutor — registration', () => {
  it('R-EXEC-01: register rejects unknown task type', () => {
    const exec = new TaskExecutor();
    expect(() =>
      exec.register('not-a-type' as TaskType, () => undefined),
    ).toThrow(TypeError);
  });

  it('R-EXEC-01: register rejects non-callable handler', () => {
    const exec = new TaskExecutor();
    expect(() =>
      exec.register(TaskType.BASH, 'nope' as unknown as () => unknown),
    ).toThrow(TypeError);
  });

  it('R-EXEC-01: re-registering replaces handler', async () => {
    const exec = new TaskExecutor();
    exec.register(TaskType.BASH, () => 'first');
    exec.register(TaskType.BASH, () => 'second');
    const r = await exec.execute(Task.bash('x'));
    expect(r.output).toBe('second');
  });

  it('R-EXEC-02: isRegistered reflects state', () => {
    const exec = new TaskExecutor();
    expect(exec.isRegistered(TaskType.BASH)).toBe(false);
    exec.register(TaskType.BASH, () => 'ok');
    expect(exec.isRegistered(TaskType.BASH)).toBe(true);
    expect(() => exec.isRegistered('bogus' as TaskType)).toThrow(TypeError);
  });

  it('R-EXEC-03: empty() yields handler-free executor', () => {
    const exec = TaskExecutor.empty();
    expect(exec.isRegistered(TaskType.BASH)).toBe(false);
  });
});

describe('TaskExecutor — execute', () => {
  it('R-EXEC-04: rejects non-Task arg', async () => {
    const exec = new TaskExecutor();
    await expect(exec.execute({} as Task)).rejects.toBeInstanceOf(TypeError);
  });

  it('R-EXEC-05: success emits STARTED then SUCCEEDED', async () => {
    const exec = new TaskExecutor();
    exec.register(TaskType.BASH, () => 'ok');
    const events = record(exec);
    const task = Task.bash('x');
    const result = await exec.execute(task);
    expect(events.map((e) => e.type)).toEqual([
      TaskEventType.STARTED,
      TaskEventType.SUCCEEDED,
    ]);
    expect(task.status).toBe(TaskStatus.SUCCEEDED);
    expect(result.output).toBe('ok');
    // R-TASK-16: returned result is same reference as task.result.
    expect(task.result).toBe(result);
  });

  it('R-EXEC-05: handler error emits STARTED then FAILED', async () => {
    const exec = new TaskExecutor();
    exec.register(TaskType.BASH, () => {
      throw new Error('boom');
    });
    const events = record(exec);
    const task = Task.bash('x');
    await expect(exec.execute(task)).rejects.toThrow(/boom/);
    expect(events.map((e) => e.type)).toEqual([
      TaskEventType.STARTED,
      TaskEventType.FAILED,
    ]);
    expect(task.status).toBe(TaskStatus.FAILED);
    expect(task.error).toBe('boom');
  });

  it('R-EXEC-06: missing handler emits only FAILED', async () => {
    const exec = new TaskExecutor();
    const events = record(exec);
    const task = Task.bash('x');
    await expect(exec.execute(task)).rejects.toBeInstanceOf(MissingHandlerError);
    expect(events.map((e) => e.type)).toEqual([TaskEventType.FAILED]);
    expect(events[0]?.previousStatus).toBe(TaskStatus.PENDING);
    expect(task.result?.terminationReason).toBe('handler');
  });

  it('R-EXEC-07: refuses already-CANCELLED tasks', async () => {
    const exec = new TaskExecutor();
    const task = Task.bash('x');
    task.cancel();
    await expect(exec.execute(task)).rejects.toBeInstanceOf(TaskCancelled);
  });

  it('R-EXEC-08: refuses non-runnable status', async () => {
    const exec = new TaskExecutor();
    exec.register(TaskType.BASH, () => 'ok');
    const task = Task.bash('x');
    await exec.execute(task);
    // SUCCEEDED cannot transition to RUNNING.
    await expect(exec.execute(task)).rejects.toBeInstanceOf(TaskExecutionError);
  });

  it('R-EXEC-10: passes upstream to handler', async () => {
    const exec = new TaskExecutor();
    let seen: ReadonlyMap<string, Task> | undefined;
    exec.register(TaskType.BASH, (ctx: TaskContext) => {
      seen = ctx.upstream;
      return 'ok';
    });
    const parent = Task.bash('p');
    const task = Task.bash('c');
    const upstream = new Map([[parent.id, parent]]);
    await exec.execute(task, { upstream });
    expect(seen?.get(parent.id)).toBe(parent);
  });
});

describe('TaskExecutor — cancel', () => {
  it('R-EXEC-13: cancel SUCCEEDED is silent no-op', async () => {
    const exec = new TaskExecutor();
    exec.register(TaskType.BASH, () => 'ok');
    const task = Task.bash('x');
    await exec.execute(task);
    const events = record(exec);
    exec.cancel(task);
    expect(events).toEqual([]);
  });

  it('R-EXEC-13: cancel PENDING emits exactly one CANCELLED', () => {
    const exec = new TaskExecutor();
    const events = record(exec);
    const task = Task.bash('x');
    exec.cancel(task);
    expect(events.map((e) => e.type)).toEqual([TaskEventType.CANCELLED]);
    expect(task.status).toBe(TaskStatus.CANCELLED);
  });

  it('R-EXEC-14: cancelled-pending result fields', () => {
    const exec = new TaskExecutor();
    const task = Task.bash('x');
    exec.cancel(task);
    const r = task.result!;
    expect(r.status).toBe(TaskStatus.CANCELLED);
    expect(r.error).toBe('cancelled');
    expect(r.terminationReason).toBe('cancelled');
    expect(r.duration).toBe(0);
    expect(r.startedAt.getTime()).toBe(r.finishedAt.getTime());
  });

  it('R-EXEC-13: cancel FAILED transitions to CANCELLED', async () => {
    const exec = new TaskExecutor();
    exec.register(TaskType.BASH, () => {
      throw new Error('boom');
    });
    const task = Task.bash('x');
    await expect(exec.execute(task)).rejects.toThrow();
    expect(task.status).toBe(TaskStatus.FAILED);
    exec.cancel(task);
    expect(task.status).toBe(TaskStatus.CANCELLED);
  });

  it('R-EXEC-13: cancel idempotent — no double emit', () => {
    const exec = new TaskExecutor();
    const events = record(exec);
    const task = Task.bash('x');
    exec.cancel(task);
    exec.cancel(task);
    exec.cancel(task);
    expect(events.length).toBe(1);
  });

  it('R-EXEC-13: cancel of RUNNING is observed by execute (one CANCELLED)', async () => {
    const exec = new TaskExecutor();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    exec.register(TaskType.BASH, async (ctx) => {
      await new Promise<void>((resolve) => {
        const onAbort = () => resolve();
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        release();
      });
      ctx.raiseIfCancelled();
      return 'unreachable';
    });
    const events = record(exec);
    const task = Task.bash('x');
    const p = exec.execute(task);
    await gate;
    exec.cancel(task);
    await expect(p).rejects.toBeInstanceOf(TaskCancelled);
    expect(task.status).toBe(TaskStatus.CANCELLED);
    expect(
      events.filter((e) => e.type === TaskEventType.CANCELLED).length,
    ).toBe(1);
    expect(events.map((e) => e.type)).toEqual([
      TaskEventType.STARTED,
      TaskEventType.CANCELLED,
    ]);
  });
});

describe('TaskExecutor — retries', () => {
  it('R-EXEC-17: succeeds after retries', async () => {
    const exec = new TaskExecutor();
    let calls = 0;
    exec.register(TaskType.BASH, () => {
      calls += 1;
      if (calls < 3) throw new Error('flaky');
      return 'ok';
    });
    const events = record(exec);
    const task = Task.bash('x');
    const r = await exec.execute(task, {
      retryPolicy: new RetryPolicy({ maxAttempts: 3 }),
    });
    expect(r.output).toBe('ok');
    expect(events.map((e) => e.type)).toEqual([
      TaskEventType.STARTED,
      TaskEventType.FAILED,
      TaskEventType.STARTED,
      TaskEventType.FAILED,
      TaskEventType.STARTED,
      TaskEventType.SUCCEEDED,
    ]);
  });

  it('R-EXEC-17: exhaustion rethrows final error', async () => {
    const exec = new TaskExecutor();
    let calls = 0;
    exec.register(TaskType.BASH, () => {
      calls += 1;
      throw new Error(`boom-${calls}`);
    });
    await expect(
      exec.execute(Task.bash('x'), {
        retryPolicy: new RetryPolicy({ maxAttempts: 3 }),
      }),
    ).rejects.toThrow(/boom-3/);
    expect(calls).toBe(3);
  });

  it('R-EXEC-18: cancellation is never retried', async () => {
    const exec = new TaskExecutor();
    let calls = 0;
    exec.register(TaskType.BASH, () => {
      calls += 1;
      throw new TaskCancelled();
    });
    await expect(
      exec.execute(Task.bash('x'), {
        retryPolicy: new RetryPolicy({ maxAttempts: 5 }),
      }),
    ).rejects.toBeInstanceOf(TaskCancelled);
    expect(calls).toBe(1);
  });

  it('R-EXEC-19: missing handler does not retry', async () => {
    const exec = new TaskExecutor();
    const events = record(exec);
    await expect(
      exec.execute(Task.bash('x'), {
        retryPolicy: new RetryPolicy({ maxAttempts: 5 }),
      }),
    ).rejects.toBeInstanceOf(MissingHandlerError);
    expect(events.length).toBe(1);
  });

  it('R-EXEC-16: execute rejects non-RetryPolicy', async () => {
    const exec = new TaskExecutor();
    exec.register(TaskType.BASH, () => 'ok');
    await expect(
      exec.execute(Task.bash('x'), {
        retryPolicy: { maxAttempts: 1 } as unknown as RetryPolicy,
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('R-EXEC-21: cancellation during backoff is honored promptly', async () => {
    const exec = new TaskExecutor();
    let calls = 0;
    exec.register(TaskType.BASH, () => {
      calls += 1;
      throw new Error('flaky');
    });
    const task = Task.bash('x');
    const start = Date.now();
    const p = exec.execute(task, {
      retryPolicy: new RetryPolicy({ maxAttempts: 5, backoff: 5 }),
    });
    setTimeout(() => exec.cancel(task), 50);
    await expect(p).rejects.toBeInstanceOf(TaskCancelled);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1500);
    expect(calls).toBe(1);
  });
});

describe('TaskExecutor — submit', () => {
  it('R-EXEC-22: submit returns a thenable with task and cancel', async () => {
    const exec = new TaskExecutor();
    exec.register(TaskType.BASH, () => 'ok');
    const task = Task.bash('x');
    const h = exec.submit(task);
    expect(h.task).toBe(task);
    expect(typeof h.cancel).toBe('function');
    const r = await h;
    expect(r.output).toBe('ok');
    // R-TASK-16
    expect(task.result).toBe(r);
  });

  it('R-EXEC-22: submit validates non-Task synchronously', () => {
    const exec = new TaskExecutor();
    expect(() => exec.submit({} as Task)).toThrow(TypeError);
  });

  it('R-EXEC-22: submit validates retryPolicy synchronously', () => {
    const exec = new TaskExecutor();
    expect(() =>
      exec.submit(Task.bash('x'), {
        retryPolicy: { maxAttempts: 1 } as unknown as RetryPolicy,
      }),
    ).toThrow(TypeError);
  });

  it('R-EXEC-24: future.cancel on queued task marks CANCELLED', async () => {
    const exec = new TaskExecutor();
    let called = false;
    exec.register(TaskType.BASH, () => {
      called = true;
      return 'ok';
    });
    const task = Task.bash('x');
    const h = exec.submit(task);
    h.cancel();
    await expect(h).rejects.toBeInstanceOf(TaskCancelled);
    expect(task.status).toBe(TaskStatus.CANCELLED);
    expect(called).toBe(false);
  });

  it('R-EXEC-24: future.cancel on RUNNING task is ignored', async () => {
    const exec = new TaskExecutor();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    exec.register(TaskType.BASH, async () => {
      release();
      await new Promise<void>((r) => setTimeout(r, 30));
      return 'done';
    });
    const task = Task.bash('x');
    const h = exec.submit(task);
    await gate;
    h.cancel();
    const r = await h;
    expect(r.output).toBe('done');
    expect(task.status).toBe(TaskStatus.SUCCEEDED);
  });
});

describe('TaskExecutor — markBlocked', () => {
  it('R-EXEC-32: transitions to BLOCKED and emits BLOCKED', () => {
    const exec = new TaskExecutor();
    const events = record(exec);
    const task = Task.bash('x');
    exec.markBlocked(task, 'parent-id');
    expect(task.status).toBe(TaskStatus.BLOCKED);
    expect(task.blockedBy).toBe('parent-id');
    expect(events.map((e) => e.type)).toEqual([TaskEventType.BLOCKED]);
    expect(events[0]?.previousStatus).toBe(TaskStatus.PENDING);
  });

  it('R-EXEC-32: rejects empty parentId', () => {
    const exec = new TaskExecutor();
    expect(() => exec.markBlocked(Task.bash('x'), '')).toThrow(TypeError);
  });
});

describe('TaskExecutor — shutdown', () => {
  it('R-EXEC-25: shutdown is idempotent and rejects later submit', async () => {
    const exec = new TaskExecutor();
    await exec.shutdown();
    await exec.shutdown();
    expect(exec.isShutdown).toBe(true);
    expect(() => exec.submit(Task.bash('x'))).toThrow(ExecutorShutdownError);
  });

  it('R-EXEC-25: shutdown waits for submitted work', async () => {
    const exec = new TaskExecutor();
    let done = false;
    exec.register(TaskType.BASH, async () => {
      await new Promise<void>((r) => setTimeout(r, 40));
      done = true;
      return 'ok';
    });
    exec.submit(Task.bash('x'));
    await exec.shutdown();
    expect(done).toBe(true);
  });

  it('R-EXEC-25: close aliases shutdown', async () => {
    const exec = new TaskExecutor();
    await exec.close();
    expect(exec.isShutdown).toBe(true);
  });

  it('R-EXEC-26: shutdown from a worker does not deadlock', async () => {
    const exec = new TaskExecutor();
    exec.register(TaskType.BASH, async () => {
      await exec.shutdown();
      return 'self';
    });
    const r = await exec.submit(Task.bash('x'));
    expect(r.output).toBe('self');
    expect(exec.isShutdown).toBe(true);
  });
});

describe('TaskExecutor — persistence', () => {
  it('R-EXEC-33: persists on every status change', async () => {
    const store = new InMemoryStore();
    const exec = new TaskExecutor({ store });
    exec.register(TaskType.BASH, () => 'ok');
    const task = Task.bash('x');
    await exec.execute(task);
    expect(store.tasks.has(task)).toBe(true);
    expect(store.tasks.get(task.id)?.status).toBe(TaskStatus.SUCCEEDED);
  });

  it('R-EXEC-33: store failure does not derail execution', async () => {
    const failingStore: Store = {
      tasks: {
        save: () => {
          throw new Error('disk full');
        },
        get: () => undefined,
        has: () => false,
        delete: () => undefined,
      },
      graphs: {
        save: () => undefined,
        get: () => undefined,
        has: () => false,
        delete: () => undefined,
      },
    };
    const exec = new TaskExecutor({ store: failingStore });
    exec.register(TaskType.BASH, () => 'ok');
    const events = record(exec);
    const task = Task.bash('x');
    const r = await exec.execute(task);
    expect(r.output).toBe('ok');
    expect(task.status).toBe(TaskStatus.SUCCEEDED);
    const types = events.map((e) => e.type);
    expect(types).toContain(TaskEventType.STARTED);
    expect(types).toContain(TaskEventType.SUCCEEDED);
    expect(
      types.filter((t) => t === TaskEventType.PERSISTENCE_FAILED).length,
    ).toBe(2);
    expect(exec.persistenceErrors.length).toBe(2);
    expect(exec.persistenceErrors[0]?.taskId).toBe(task.id);
  });

  it('R-EXEC-15: cancel persists before CANCELLED event', async () => {
    const store = new InMemoryStore();
    const exec = new TaskExecutor({ store });
    const task = Task.bash('x');
    exec.cancel(task);
    // give the void this.#persist a tick
    await Promise.resolve();
    expect(store.tasks.get(task.id)?.status).toBe(TaskStatus.CANCELLED);
  });
});
