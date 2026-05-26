import { describe, expect, it } from 'vitest';

import { Task, TaskResult, TaskStatus } from '../src/index.js';

const allowedEdges: Array<[TaskStatus, TaskStatus]> = [
  [TaskStatus.PENDING, TaskStatus.RUNNING],
  [TaskStatus.PENDING, TaskStatus.FAILED],
  [TaskStatus.PENDING, TaskStatus.CANCELLED],
  [TaskStatus.PENDING, TaskStatus.BLOCKED],
  [TaskStatus.RUNNING, TaskStatus.SUCCEEDED],
  [TaskStatus.RUNNING, TaskStatus.FAILED],
  [TaskStatus.RUNNING, TaskStatus.CANCELLED],
  [TaskStatus.FAILED, TaskStatus.RUNNING],
  [TaskStatus.FAILED, TaskStatus.CANCELLED],
  [TaskStatus.BLOCKED, TaskStatus.RUNNING],
  [TaskStatus.BLOCKED, TaskStatus.CANCELLED],
];

const allStatuses = [
  TaskStatus.PENDING,
  TaskStatus.RUNNING,
  TaskStatus.SUCCEEDED,
  TaskStatus.FAILED,
  TaskStatus.CANCELLED,
  TaskStatus.BLOCKED,
];

function driveTo(task: Task, target: TaskStatus): void {
  // Drive a fresh task through the allowed edges to the requested status.
  switch (target) {
    case TaskStatus.PENDING:
      return;
    case TaskStatus.RUNNING:
      task.transitionTo(TaskStatus.RUNNING);
      return;
    case TaskStatus.SUCCEEDED:
      task.transitionTo(TaskStatus.RUNNING);
      task.transitionTo(TaskStatus.SUCCEEDED);
      return;
    case TaskStatus.FAILED:
      task.transitionTo(TaskStatus.RUNNING);
      task.transitionTo(TaskStatus.FAILED, { error: 'boom' });
      return;
    case TaskStatus.CANCELLED:
      task.transitionTo(TaskStatus.CANCELLED);
      return;
    case TaskStatus.BLOCKED:
      task.transitionTo(TaskStatus.BLOCKED, { blockedBy: 'parent' });
      return;
  }
}

describe('State machine (R-SM-01..11)', () => {
  it('R-SM-01 every allowed edge is accepted by canTransitionTo and transitionTo', () => {
    for (const [from, to] of allowedEdges) {
      const t = Task.bash('x');
      driveTo(t, from);
      expect(t.canTransitionTo(to)).toBe(true);
      t.transitionTo(to, to === TaskStatus.FAILED ? { error: 'e' } : undefined);
      expect(t.status).toBe(to);
    }
  });

  it('R-SM-01 disallowed transitions are rejected and leave state unchanged', () => {
    for (const from of allStatuses) {
      for (const to of allStatuses) {
        const isAllowed = allowedEdges.some(([f, x]) => f === from && x === to);
        if (isAllowed) continue;
        const t = Task.bash('x');
        driveTo(t, from);
        const preStatus = t.status;
        const preError = t.error;
        expect(t.canTransitionTo(to)).toBe(false);
        expect(() => t.transitionTo(to)).toThrow();
        expect(t.status).toBe(preStatus);
        expect(t.error).toBe(preError);
      }
    }
  });

  it('R-SM-02 SUCCEEDED and CANCELLED are sinks', () => {
    for (const sink of [TaskStatus.SUCCEEDED, TaskStatus.CANCELLED]) {
      const t = Task.bash('x');
      driveTo(t, sink);
      for (const to of allStatuses) {
        expect(t.canTransitionTo(to)).toBe(false);
      }
      expect(t.isSink).toBe(true);
      expect(t.isTerminal).toBe(true);
    }
  });

  it('R-SM-03 entering RUNNING clears prior-run result, blockedBy, and error', () => {
    const t = Task.bash('x');
    const fakeResult = new TaskResult({
      taskId: t.id,
      status: TaskStatus.FAILED,
      startedAt: new Date(),
      finishedAt: new Date(),
      duration: 0,
      output: '',
      error: 'boom',
      raw: null,
      returncode: null,
      terminationReason: 'handler',
    });
    t.transitionTo(TaskStatus.RUNNING);
    t.transitionTo(TaskStatus.FAILED, { error: 'boom', result: fakeResult });
    expect(t.result).toBe(fakeResult);
    expect(t.error).toBe('boom');

    t.transitionTo(TaskStatus.RUNNING);
    expect(t.result).toBeNull();
    expect(t.error).toBeUndefined();
  });

  it('R-SM-03 entering RUNNING from BLOCKED clears blockedBy', () => {
    const t = Task.bash('x');
    t.transitionTo(TaskStatus.BLOCKED, { blockedBy: 'parent-id' });
    expect(t.blockedBy).toBe('parent-id');
    t.transitionTo(TaskStatus.RUNNING);
    expect(t.blockedBy).toBeUndefined();
  });

  it('R-SM-04 entering SUCCEEDED clears explicit error', () => {
    const t = Task.bash('x');
    t.transitionTo(TaskStatus.RUNNING);
    t.transitionTo(TaskStatus.SUCCEEDED, { error: 'should be cleared' });
    expect(t.error).toBeUndefined();
  });

  it('R-SM-05 FAILED preserves supplied error', () => {
    const t = Task.bash('x');
    t.transitionTo(TaskStatus.RUNNING);
    t.transitionTo(TaskStatus.FAILED, { error: 'boom' });
    expect(t.status).toBe(TaskStatus.FAILED);
    expect(t.error).toBe('boom');
  });

  it('R-SM-06 FAILED -> CANCELLED preserves prior error', () => {
    const t = Task.bash('x');
    t.transitionTo(TaskStatus.RUNNING);
    t.transitionTo(TaskStatus.FAILED, { error: 'boom' });
    t.cancel();
    expect(t.status).toBe(TaskStatus.CANCELLED);
    expect(t.error).toBe('boom');
  });

  it('R-SM-07 cancel() is idempotent on sink states', () => {
    const succeeded = Task.bash('x');
    driveTo(succeeded, TaskStatus.SUCCEEDED);
    expect(() => succeeded.cancel()).not.toThrow();
    expect(succeeded.status).toBe(TaskStatus.SUCCEEDED);

    const cancelled = Task.bash('x');
    driveTo(cancelled, TaskStatus.CANCELLED);
    expect(() => cancelled.cancel()).not.toThrow();
    expect(cancelled.status).toBe(TaskStatus.CANCELLED);
  });

  it('R-SM-08 FAILED and BLOCKED are retryable to RUNNING', () => {
    const failed = Task.bash('x');
    driveTo(failed, TaskStatus.FAILED);
    expect(failed.canTransitionTo(TaskStatus.RUNNING)).toBe(true);
    failed.transitionTo(TaskStatus.RUNNING);
    expect(failed.status).toBe(TaskStatus.RUNNING);

    const blocked = Task.bash('x');
    driveTo(blocked, TaskStatus.BLOCKED);
    expect(blocked.canTransitionTo(TaskStatus.RUNNING)).toBe(true);
    blocked.transitionTo(TaskStatus.RUNNING);
    expect(blocked.status).toBe(TaskStatus.RUNNING);
  });

  it('R-SM-09 SUCCEEDED tasks reject mutation of payload/title/description/timeout/error', () => {
    const t = Task.bash('echo hi', { title: 'T' });
    driveTo(t, TaskStatus.SUCCEEDED);
    expect(() => {
      t.payload = 'new';
    }).toThrow();
    expect(() => {
      t.title = 'new';
    }).toThrow();
    expect(() => {
      t.description = 'new';
    }).toThrow();
    expect(() => {
      t.timeout = 5;
    }).toThrow();
    expect(() => {
      t.error = 'e';
    }).toThrow();
    expect(t.payload).toBe('echo hi');
    expect(t.title).toBe('T');
  });

  it('R-SM-10 id is read-only', () => {
    const t = Task.bash('x');
    expect(() => {
      (t as unknown as { id: string }).id = 'other';
    }).toThrow();
  });

  it('R-SM-11 status predicates agree with classifications', () => {
    const cases: Array<{
      status: TaskStatus;
      active: boolean;
      sink: boolean;
      bad: boolean;
    }> = [
      { status: TaskStatus.PENDING, active: true, sink: false, bad: false },
      { status: TaskStatus.RUNNING, active: true, sink: false, bad: false },
      { status: TaskStatus.SUCCEEDED, active: false, sink: true, bad: false },
      { status: TaskStatus.FAILED, active: false, sink: false, bad: true },
      { status: TaskStatus.CANCELLED, active: false, sink: true, bad: true },
      { status: TaskStatus.BLOCKED, active: false, sink: false, bad: true },
    ];
    for (const c of cases) {
      const t = Task.bash('x');
      driveTo(t, c.status);
      expect(t.isActive).toBe(c.active);
      expect(t.isSink).toBe(c.sink);
      expect(t.isBad).toBe(c.bad);
      expect(t.isTerminal).toBe(c.sink);
      expect(t.isPending).toBe(c.status === TaskStatus.PENDING);
      expect(t.isRunning).toBe(c.status === TaskStatus.RUNNING);
      expect(t.isSucceeded).toBe(c.status === TaskStatus.SUCCEEDED);
      expect(t.isFailed).toBe(c.status === TaskStatus.FAILED);
      expect(t.isCancelled).toBe(c.status === TaskStatus.CANCELLED);
      expect(t.isBlocked).toBe(c.status === TaskStatus.BLOCKED);
    }
  });
});
