import { TaskStatus, type Task } from './task.js';

export enum TaskEventType {
  STARTED = 'started',
  PROGRESS = 'progress',
  OUTPUT = 'output',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  BLOCKED = 'blocked',
  PERSISTENCE_FAILED = 'persistence_failed',
}

export type OutputStream = 'stdout' | 'stderr';

// R-EVT-11: events are immutable; factories freeze them.
export interface TaskEvent {
  readonly type: TaskEventType;
  readonly task: Task;
  readonly taskId: string;
  readonly timestamp: Date;
  readonly previousStatus: TaskStatus | null;
  readonly status: TaskStatus | null;
  readonly error: string | null;
  readonly progressPercent: number | null;
  readonly progressMessage: string | null;
  readonly outputStream: OutputStream | null;
  readonly outputChunk: string | null;
}

interface BaseInit {
  task: Task;
  timestamp?: Date;
}

interface StatusChangeInit extends BaseInit {
  previousStatus: TaskStatus;
}

interface FailedInit extends StatusChangeInit {
  error: string;
}

interface ProgressInit extends BaseInit {
  percent?: number;
  message?: string;
}

interface OutputInit extends BaseInit {
  stream: OutputStream;
  chunk: string;
}

interface PersistenceFailedInit extends BaseInit {
  error: string;
}

function freezeEvent(event: TaskEvent): TaskEvent {
  return Object.freeze(event);
}

function makeStatusEvent(
  type: TaskEventType,
  status: TaskStatus,
  init: StatusChangeInit,
  extras: { error?: string } = {},
): TaskEvent {
  return freezeEvent({
    type,
    task: init.task,
    taskId: init.task.id,
    timestamp: init.timestamp ?? new Date(),
    previousStatus: init.previousStatus,
    status,
    error: extras.error ?? null,
    progressPercent: null,
    progressMessage: null,
    outputStream: null,
    outputChunk: null,
  });
}

// R-EVT-14: OUTPUT carries a single stream and a chunk.
function validateOutput(init: OutputInit): void {
  if (init.stream !== 'stdout' && init.stream !== 'stderr') {
    throw new TypeError(`outputStream must be 'stdout' or 'stderr', got ${String(init.stream)}`);
  }
  if (typeof init.chunk !== 'string') {
    throw new TypeError(`outputChunk must be a string, got ${typeof init.chunk}`);
  }
}

// R-EVT-15: PROGRESS carries percent and/or message; reject empty/invalid.
function validateProgress(init: ProgressInit): void {
  const hasPercent = init.percent !== undefined;
  const hasMessage = init.message !== undefined;
  if (!hasPercent && !hasMessage) {
    throw new TypeError('progress event requires percent and/or message');
  }
  if (hasPercent) {
    const p = init.percent;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100) {
      throw new RangeError(`progressPercent must be a finite number in [0, 100], got ${String(p)}`);
    }
  }
  if (hasMessage) {
    if (typeof init.message !== 'string') {
      throw new TypeError(`progressMessage must be a string, got ${typeof init.message}`);
    }
    if (init.message.length === 0) {
      throw new TypeError('progressMessage must be non-empty');
    }
  }
}

export const TaskEvents = {
  started(init: StatusChangeInit): TaskEvent {
    return makeStatusEvent(TaskEventType.STARTED, TaskStatus.RUNNING, init);
  },
  succeeded(init: StatusChangeInit): TaskEvent {
    return makeStatusEvent(TaskEventType.SUCCEEDED, TaskStatus.SUCCEEDED, init);
  },
  failed(init: FailedInit): TaskEvent {
    return makeStatusEvent(TaskEventType.FAILED, TaskStatus.FAILED, init, { error: init.error });
  },
  cancelled(init: StatusChangeInit): TaskEvent {
    return makeStatusEvent(TaskEventType.CANCELLED, TaskStatus.CANCELLED, init);
  },
  blocked(init: StatusChangeInit): TaskEvent {
    return makeStatusEvent(TaskEventType.BLOCKED, TaskStatus.BLOCKED, init);
  },
  progress(init: ProgressInit): TaskEvent {
    validateProgress(init);
    return freezeEvent({
      type: TaskEventType.PROGRESS,
      task: init.task,
      taskId: init.task.id,
      timestamp: init.timestamp ?? new Date(),
      previousStatus: null,
      status: null,
      error: null,
      progressPercent: init.percent ?? null,
      progressMessage: init.message ?? null,
      outputStream: null,
      outputChunk: null,
    });
  },
  output(init: OutputInit): TaskEvent {
    validateOutput(init);
    return freezeEvent({
      type: TaskEventType.OUTPUT,
      task: init.task,
      taskId: init.task.id,
      timestamp: init.timestamp ?? new Date(),
      previousStatus: null,
      status: null,
      error: null,
      progressPercent: null,
      progressMessage: null,
      outputStream: init.stream,
      outputChunk: init.chunk,
    });
  },
  persistenceFailed(init: PersistenceFailedInit): TaskEvent {
    return freezeEvent({
      type: TaskEventType.PERSISTENCE_FAILED,
      task: init.task,
      taskId: init.task.id,
      timestamp: init.timestamp ?? new Date(),
      previousStatus: null,
      status: null,
      error: init.error,
      progressPercent: null,
      progressMessage: null,
      outputStream: null,
      outputChunk: null,
    });
  },
} as const;

export type EventHandler<T> = (event: T) => void;

export class EventBus<T> {
  readonly #subscribers = new Set<EventHandler<T>>();
  readonly #errors: Error[] = [];

  // R-EVT-08, R-EVT-10
  public subscribe(handler: EventHandler<T>): () => void {
    if (typeof handler !== 'function') {
      throw new TypeError(`subscriber must be a function, got ${handler === null ? 'null' : typeof handler}`);
    }
    this.#subscribers.add(handler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#subscribers.delete(handler);
    };
  }

  // R-EVT-09
  public async subscribeScoped<R>(
    handler: EventHandler<T>,
    body: () => R | Promise<R>,
  ): Promise<R> {
    const unsubscribe = this.subscribe(handler);
    try {
      return await body();
    } finally {
      unsubscribe();
    }
  }

  // R-EVT-07, R-EVT-16
  public emit(event: T): void {
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(event);
      } catch (error) {
        this.#errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  // R-EVT-16: read-only view; mutations of the returned value MUST NOT touch internal state.
  public get errors(): readonly Error[] {
    return [...this.#errors];
  }
}
