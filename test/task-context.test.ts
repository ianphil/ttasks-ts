import { describe, expect, it } from 'vitest';

import {
  TaskCancelled,
  TaskContext,
  type TaskContextInit,
} from '../src/executor.js';
import { Task, TaskType } from '../src/task.js';

function ctxFor(task: Task, overrides: Partial<TaskContextInit> = {}): TaskContext {
  const controller = new AbortController();
  return new TaskContext({
    task,
    signal: controller.signal,
    isCancelled: () => controller.signal.aborted,
    ...overrides,
  });
}

describe('TaskContext', () => {
  it('R-EXEC-09: exposes read-only task view', () => {
    const task = Task.bash('echo hi', { title: 't', description: 'd' });
    const ctx = ctxFor(task);
    expect(ctx.id).toBe(task.id);
    expect(ctx.title).toBe('t');
    expect(ctx.description).toBe('d');
    expect(ctx.payload).toBe('echo hi');
    expect(ctx.type).toBe(TaskType.BASH);
    expect(ctx.timeout).toBeUndefined();
    expect(ctx.status).toBe(task.status);
  });

  it('R-EXEC-10: upstream is copied at construction', () => {
    const task = Task.bash('x');
    const upstream = new Map<string, Task>();
    const parent = Task.bash('y');
    upstream.set(parent.id, parent);
    const ctx = ctxFor(task, { upstream });
    upstream.delete(parent.id);
    expect(ctx.upstream.has(parent.id)).toBe(true);
    expect(ctx.upstream.size).toBe(1);
  });

  it('R-EXEC-11: emitProgress without emitter throws', () => {
    const ctx = ctxFor(Task.bash('x'));
    expect(() => ctx.emitProgress(50, 'half')).toThrow(/emitter/);
  });

  it('R-EXEC-12: emitProgress after cancellation throws TaskCancelled', () => {
    const task = Task.bash('x');
    let cancelled = false;
    const ctx = new TaskContext({
      task,
      signal: new AbortController().signal,
      isCancelled: () => cancelled,
      emitter: () => undefined,
    });
    cancelled = true;
    expect(() => ctx.emitProgress(10, 'm')).toThrow(TaskCancelled);
  });

  it('raiseIfCancelled honors the cancellation flag', () => {
    let cancelled = false;
    const ctx = new TaskContext({
      task: Task.bash('x'),
      signal: new AbortController().signal,
      isCancelled: () => cancelled,
    });
    expect(() => ctx.raiseIfCancelled()).not.toThrow();
    cancelled = true;
    expect(() => ctx.raiseIfCancelled()).toThrow(TaskCancelled);
  });
});
