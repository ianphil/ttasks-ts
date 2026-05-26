import { describe, expect, it } from 'vitest';

import { TaskResult, TaskStatus, normalizeTaskResult } from '../src/index.js';

describe('TaskResult (R-TASK-13, R-TASK-14)', () => {
  it('R-TASK-13 TaskResult is frozen / immutable after construction', () => {
    const r = new TaskResult({
      taskId: 'id',
      status: TaskStatus.SUCCEEDED,
      startedAt: new Date(),
      finishedAt: new Date(),
      duration: 0,
      output: 'hi',
      error: null,
      raw: 'hi',
      returncode: null,
      terminationReason: null,
    });
    expect(Object.isFrozen(r)).toBe(true);
    expect(() => {
      (r as unknown as { output: string }).output = 'nope';
    }).toThrow();
  });

  it('R-TASK-14 string handler return normalizes to output and raw', () => {
    const startedAt = new Date();
    const finishedAt = new Date(startedAt.getTime() + 5);
    const r = normalizeTaskResult({
      taskId: 'id',
      status: TaskStatus.SUCCEEDED,
      startedAt,
      finishedAt,
      raw: 'hello',
    });
    expect(r.output).toBe('hello');
    expect(r.raw).toBe('hello');
    expect(r.error).toBeNull();
    expect(r.returncode).toBeNull();
    expect(r.duration).toBe(5);
  });

  it('R-TASK-14 subprocess-like return copies stdout, stderr, returncode', () => {
    const completion = { stdout: 'hello\n', stderr: '', returncode: 0 };
    const r = normalizeTaskResult({
      taskId: 'id',
      status: TaskStatus.SUCCEEDED,
      startedAt: new Date(),
      finishedAt: new Date(),
      raw: completion,
    });
    expect(r.output).toBe('hello\n');
    expect(r.error).toBeNull();
    expect(r.returncode).toBe(0);
    expect(r.raw).toBe(completion);
  });

  it('R-TASK-14 subprocess-like with non-empty stderr keeps the message', () => {
    const completion = { stdout: '', stderr: 'oops', returncode: 1 };
    const r = normalizeTaskResult({
      taskId: 'id',
      status: TaskStatus.FAILED,
      startedAt: new Date(),
      finishedAt: new Date(),
      raw: completion,
    });
    expect(r.output).toBe('');
    expect(r.error).toBe('oops');
    expect(r.returncode).toBe(1);
    expect(r.raw).toBe(completion);
  });

  it('R-TASK-14 other return values default fields and preserve raw', () => {
    const payload = { custom: true };
    const r = normalizeTaskResult({
      taskId: 'id',
      status: TaskStatus.SUCCEEDED,
      startedAt: new Date(),
      finishedAt: new Date(),
      raw: payload,
    });
    expect(r.output).toBe('');
    expect(r.error).toBeNull();
    expect(r.returncode).toBeNull();
    expect(r.raw).toBe(payload);
  });
});
