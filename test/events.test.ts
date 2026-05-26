import { describe, expect, it, vi } from 'vitest';

import {
  EventBus,
  Task,
  TaskEventType,
  TaskEvents,
  TaskStatus,
  type TaskEvent,
} from '../src/index.js';

describe('Event types and shape', () => {
  it('R-EVT-01 defines every required event type', () => {
    const required = [
      'STARTED',
      'PROGRESS',
      'OUTPUT',
      'SUCCEEDED',
      'FAILED',
      'CANCELLED',
      'BLOCKED',
      'PERSISTENCE_FAILED',
    ];
    for (const name of required) {
      expect((TaskEventType as Record<string, unknown>)[name]).toBeDefined();
    }
  });

  it('R-EVT-11 events are immutable (frozen) once emitted', () => {
    const t = Task.bash('echo hi');
    const evt = TaskEvents.started({ task: t, previousStatus: TaskStatus.PENDING });
    expect(Object.isFrozen(evt)).toBe(true);
    expect(() => {
      (evt as unknown as { type: TaskEventType }).type = TaskEventType.FAILED;
    }).toThrow();
  });

  it('R-EVT-11 event.task remains a live reference', () => {
    const t = Task.bash('echo hi');
    const evt = TaskEvents.started({ task: t, previousStatus: TaskStatus.PENDING });
    t.transitionTo(TaskStatus.RUNNING);
    expect(evt.task).toBe(t);
    expect(evt.task.status).toBe(TaskStatus.RUNNING);
  });

  it('R-EVT-12 status-changing events carry previousStatus and matching status', () => {
    const t = Task.bash('echo hi');
    t.transitionTo(TaskStatus.RUNNING);
    const evt = TaskEvents.succeeded({ task: t, previousStatus: TaskStatus.RUNNING });
    expect(evt.type).toBe(TaskEventType.SUCCEEDED);
    expect(evt.previousStatus).toBe(TaskStatus.RUNNING);
    expect(evt.status).toBe(TaskStatus.SUCCEEDED);
  });

  it('R-EVT-12 PROGRESS / OUTPUT / PERSISTENCE_FAILED have null previousStatus', () => {
    const t = Task.bash('echo hi');
    const progress = TaskEvents.progress({ task: t, percent: 50 });
    const output = TaskEvents.output({ task: t, stream: 'stdout', chunk: 'hi' });
    const persist = TaskEvents.persistenceFailed({ task: t, error: 'db down' });
    expect(progress.previousStatus).toBeNull();
    expect(output.previousStatus).toBeNull();
    expect(persist.previousStatus).toBeNull();
    expect(progress.status).toBeNull();
    expect(output.status).toBeNull();
    expect(persist.status).toBeNull();
  });
});

describe('OUTPUT events (R-EVT-14)', () => {
  it('R-EVT-14 OUTPUT carries stream and chunk', () => {
    const t = Task.bash('echo hi');
    const evt = TaskEvents.output({ task: t, stream: 'stdout', chunk: 'hello' });
    expect(evt.type).toBe(TaskEventType.OUTPUT);
    expect(evt.outputStream).toBe('stdout');
    expect(evt.outputChunk).toBe('hello');
  });

  it('R-EVT-14 rejects invalid output stream values', () => {
    const t = Task.bash('echo hi');
    expect(() =>
      TaskEvents.output({ task: t, stream: 'other' as 'stdout', chunk: 'x' }),
    ).toThrow();
  });
});

describe('PROGRESS events (R-EVT-15)', () => {
  it('R-EVT-15 accepts percent in [0, 100]', () => {
    const t = Task.bash('x');
    expect(TaskEvents.progress({ task: t, percent: 0 }).progressPercent).toBe(0);
    expect(TaskEvents.progress({ task: t, percent: 100 }).progressPercent).toBe(100);
  });

  it('R-EVT-15 accepts message-only progress', () => {
    const t = Task.bash('x');
    const evt = TaskEvents.progress({ task: t, message: 'half-done' });
    expect(evt.progressMessage).toBe('half-done');
    expect(evt.progressPercent).toBeNull();
  });

  it('R-EVT-15 rejects empty progress (no percent and no message)', () => {
    const t = Task.bash('x');
    expect(() => TaskEvents.progress({ task: t })).toThrow();
  });

  it('R-EVT-15 rejects percent outside [0, 100]', () => {
    const t = Task.bash('x');
    expect(() => TaskEvents.progress({ task: t, percent: -1 })).toThrow();
    expect(() => TaskEvents.progress({ task: t, percent: 101 })).toThrow();
    expect(() => TaskEvents.progress({ task: t, percent: Number.NaN })).toThrow();
    expect(() => TaskEvents.progress({ task: t, percent: Number.POSITIVE_INFINITY })).toThrow();
  });

  it('R-EVT-15 rejects non-numeric percent and non-string message', () => {
    const t = Task.bash('x');
    expect(() =>
      TaskEvents.progress({ task: t, percent: '50' as unknown as number }),
    ).toThrow();
    expect(() =>
      TaskEvents.progress({ task: t, message: 42 as unknown as string }),
    ).toThrow();
    expect(() => TaskEvents.progress({ task: t, message: '' })).toThrow();
  });
});

describe('EventBus', () => {
  it('R-EVT-08 subscribe returns an unsubscribe that prevents future delivery', () => {
    const bus = new EventBus<TaskEvent>();
    const seen: TaskEvent[] = [];
    const unsub = bus.subscribe((e) => seen.push(e));
    const t = Task.bash('x');
    const evt = TaskEvents.started({ task: t, previousStatus: TaskStatus.PENDING });
    bus.emit(evt);
    unsub();
    bus.emit(evt);
    expect(seen).toHaveLength(1);
  });

  it('R-EVT-08 unsubscribe is idempotent', () => {
    const bus = new EventBus<TaskEvent>();
    const unsub = bus.subscribe(() => undefined);
    expect(() => {
      unsub();
      unsub();
      unsub();
    }).not.toThrow();
  });

  it('R-EVT-10 subscribe rejects non-callable arguments', () => {
    const bus = new EventBus<TaskEvent>();
    expect(() => bus.subscribe('not a function' as unknown as () => void)).toThrow(TypeError);
    expect(() => bus.subscribe(null as unknown as () => void)).toThrow(TypeError);
    expect(() => bus.subscribe(undefined as unknown as () => void)).toThrow(TypeError);
    expect(() => bus.subscribe({} as unknown as () => void)).toThrow(TypeError);
  });

  it('R-EVT-07 subscriber errors do not stop other subscribers', () => {
    const bus = new EventBus<TaskEvent>();
    const second = vi.fn();
    bus.subscribe(() => {
      throw new Error('first failed');
    });
    bus.subscribe(second);
    const third = vi.fn();
    bus.subscribe(third);

    const t = Task.bash('x');
    const evt = TaskEvents.started({ task: t, previousStatus: TaskStatus.PENDING });
    expect(() => bus.emit(evt)).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
    expect(third).toHaveBeenCalledTimes(1);
  });

  it('R-EVT-07 subscriber errors do not change task state', () => {
    const bus = new EventBus<TaskEvent>();
    bus.subscribe(() => {
      throw new Error('nope');
    });
    const t = Task.bash('x');
    const before = t.status;
    bus.emit(TaskEvents.started({ task: t, previousStatus: TaskStatus.PENDING }));
    expect(t.status).toBe(before);
  });

  it('R-EVT-16 bus collects subscriber errors in order', () => {
    const bus = new EventBus<TaskEvent>();
    bus.subscribe(() => {
      throw new Error('e1');
    });
    bus.subscribe(() => {
      throw new Error('e2');
    });
    const t = Task.bash('x');
    bus.emit(TaskEvents.started({ task: t, previousStatus: TaskStatus.PENDING }));
    bus.emit(TaskEvents.started({ task: t, previousStatus: TaskStatus.PENDING }));
    expect(bus.errors.map((e) => e.message)).toEqual(['e1', 'e2', 'e1', 'e2']);
  });

  it('R-EVT-16 errors view does not allow external mutation', () => {
    const bus = new EventBus<TaskEvent>();
    bus.subscribe(() => {
      throw new Error('boom');
    });
    const t = Task.bash('x');
    bus.emit(TaskEvents.started({ task: t, previousStatus: TaskStatus.PENDING }));
    const view = bus.errors;
    expect(view).toHaveLength(1);
    // Mutating the returned view must not affect the bus's internal collection.
    (view as Error[]).push(new Error('injected'));
    expect(bus.errors).toHaveLength(1);
  });

  it('R-EVT-09 subscribeScoped subscribes for the duration of the callback', async () => {
    const bus = new EventBus<TaskEvent>();
    const seen: TaskEvent[] = [];
    const t = Task.bash('x');
    const evt = TaskEvents.started({ task: t, previousStatus: TaskStatus.PENDING });

    await bus.subscribeScoped(
      (e) => seen.push(e),
      async () => {
        bus.emit(evt);
        bus.emit(evt);
      },
    );

    // Subscriber removed after callback returns.
    bus.emit(evt);
    expect(seen).toHaveLength(2);
  });

  it('R-EVT-09 subscribeScoped unsubscribes even when the callback throws', async () => {
    const bus = new EventBus<TaskEvent>();
    const seen: TaskEvent[] = [];
    const t = Task.bash('x');
    const evt = TaskEvents.started({ task: t, previousStatus: TaskStatus.PENDING });

    await expect(
      bus.subscribeScoped(
        (e) => seen.push(e),
        async () => {
          bus.emit(evt);
          throw new Error('boom');
        },
      ),
    ).rejects.toThrow('boom');

    bus.emit(evt);
    expect(seen).toHaveLength(1);
  });
});
