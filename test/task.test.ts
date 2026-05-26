import { describe, expect, it } from 'vitest';

import { Task, TaskStatus, TaskType } from '../src/index.js';

describe('Task construction and field rules', () => {
  it('R-TASK-01 rejects unknown task type at construction', () => {
    expect(() => new Task('not-a-type' as TaskType, 'echo hi')).toThrow();
  });

  it('R-TASK-01 accepts every built-in task type', () => {
    for (const type of [TaskType.BASH, TaskType.POWERSHELL, TaskType.PROMPT, TaskType.AGENT]) {
      const t = new Task(type, 'payload');
      expect(t.type).toBe(type);
    }
  });

  it('R-TASK-02 rejects zero or negative timeouts at construction', () => {
    expect(() => Task.bash('echo hi', { timeout: 0 })).toThrow();
    expect(() => Task.bash('echo hi', { timeout: -1 })).toThrow();
  });

  it('R-TASK-02 rejects zero or negative timeouts on later assignment', () => {
    const t = Task.bash('echo hi');
    expect(() => {
      t.timeout = 0;
    }).toThrow();
    expect(() => {
      t.timeout = -5;
    }).toThrow();
  });

  it('R-TASK-03 defaults timeout to undefined (unbounded)', () => {
    const t = Task.bash('echo hi');
    expect(t.timeout).toBeUndefined();
  });

  it('R-TASK-04 defaults title and description to empty string', () => {
    const t = Task.bash('echo hi');
    expect(t.title).toBe('');
    expect(t.description).toBe('');
  });

  it('R-TASK-05 each constructed task gets a fresh id', () => {
    const a = Task.bash('echo a');
    const b = Task.bash('echo b');
    expect(a.id).not.toBe(b.id);
    expect(a.id).toBeTruthy();
  });

  it('R-TASK-06 distinct ids are not considered equal members', () => {
    const a = Task.bash('echo a');
    const b = Task.bash('echo b');
    const byId = new Map<string, Task>();
    byId.set(a.id, a);
    byId.set(b.id, b);
    expect(byId.size).toBe(2);
  });

  it('R-TASK-07 status is read-only externally', () => {
    const t = Task.bash('echo hi');
    expect(() => {
      (t as unknown as { status: TaskStatus }).status = TaskStatus.RUNNING;
    }).toThrow();
    expect(t.status).toBe(TaskStatus.PENDING);
  });

  it('R-TASK-08 result and blockedBy are read-only externally', () => {
    const t = Task.bash('echo hi');
    expect(() => {
      (t as unknown as { result: unknown }).result = {} as never;
    }).toThrow();
    expect(() => {
      (t as unknown as { blockedBy: string }).blockedBy = 'x';
    }).toThrow();
  });

  it('R-TASK-09 failed tasks remain mutable for retry', () => {
    const t = Task.bash('echo hi');
    t.transitionTo(TaskStatus.RUNNING);
    t.transitionTo(TaskStatus.FAILED, { error: 'boom' });
    expect(t.error).toBe('boom');
    t.payload = 'echo new';
    t.title = 'retry';
    t.description = 'second attempt';
    t.timeout = 5;
    t.error = undefined;
    expect(t.payload).toBe('echo new');
    expect(t.title).toBe('retry');
    expect(t.description).toBe('second attempt');
    expect(t.timeout).toBe(5);
    expect(t.error).toBeUndefined();
  });

  it('R-TASK-10 built-in task type values are stable strings', () => {
    expect(TaskType.BASH).toBe('bash');
    expect(TaskType.POWERSHELL).toBe('powershell');
    expect(TaskType.PROMPT).toBe('prompt');
    expect(TaskType.AGENT).toBe('agent');
  });

  it('R-TASK-15 toString includes id, title, and status', () => {
    const t = Task.bash('secret payload', { title: 'My Task' });
    const s = t.toString();
    expect(s).toContain(t.id);
    expect(s).toContain('My Task');
    expect(s).toContain(TaskStatus.PENDING);
    expect(s).not.toContain('secret payload');
  });
});
