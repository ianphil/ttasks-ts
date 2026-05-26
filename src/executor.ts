import { AsyncLocalStorage } from 'node:async_hooks';

import { EventBus, TaskEvents, type TaskEvent } from './events.js';
import type { Store } from './store.js';
import {
  Task,
  TaskStatus,
  TaskType,
  TaskResult,
  normalizeTaskResult,
} from './task.js';

// --- Errors -----------------------------------------------------------------

export class TaskExecutionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TaskExecutionError';
  }
}

export class TaskTimeoutError extends TaskExecutionError {
  public constructor(message = 'Task timed out') {
    super(message);
    this.name = 'TaskTimeoutError';
  }
}

export class TaskCancelled extends Error {
  public constructor(message = 'Task cancelled') {
    super(message);
    this.name = 'TaskCancelled';
  }
}

export class MissingHandlerError extends TaskExecutionError {
  public constructor(taskType: TaskType) {
    super(`No handler registered for task type '${taskType}'`);
    this.name = 'MissingHandlerError';
  }
}

export class ExecutorShutdownError extends Error {
  public constructor(message = 'Executor has been shut down') {
    super(message);
    this.name = 'ExecutorShutdownError';
  }
}

// --- Retry policy -----------------------------------------------------------

export interface RetryPolicyInit {
  maxAttempts: number;
  backoff?: number;
}

export class RetryPolicy {
  public readonly maxAttempts: number;
  public readonly backoff: number;

  public constructor(init: RetryPolicyInit) {
    if (!Number.isInteger(init.maxAttempts)) {
      throw new TypeError(`maxAttempts must be an integer, got ${String(init.maxAttempts)}`);
    }
    if (init.maxAttempts < 1) {
      throw new RangeError(`maxAttempts must be >= 1, got ${init.maxAttempts}`);
    }
    const backoff = init.backoff ?? 0;
    if (typeof backoff !== 'number' || !Number.isFinite(backoff)) {
      throw new TypeError(`backoff must be a finite number, got ${String(backoff)}`);
    }
    if (backoff < 0) {
      throw new RangeError(`backoff must be >= 0, got ${backoff}`);
    }
    this.maxAttempts = init.maxAttempts;
    this.backoff = backoff;
    Object.freeze(this);
  }
}

const VALID_TASK_TYPES: ReadonlySet<string> = new Set(Object.values(TaskType));

function assertTaskType(value: unknown): asserts value is TaskType {
  if (typeof value !== 'string' || !VALID_TASK_TYPES.has(value)) {
    throw new TypeError(`Unknown task type: ${String(value)}`);
  }
}

function assertCallable(value: unknown, label: string): void {
  if (typeof value !== 'function') {
    throw new TypeError(
      `${label} must be a function, got ${value === null ? 'null' : typeof value}`,
    );
  }
}

function assertTask(value: unknown): asserts value is Task {
  if (!(value instanceof Task)) {
    throw new TypeError(`expected a Task, got ${value === null ? 'null' : typeof value}`);
  }
}

function assertRetryPolicy(value: unknown): asserts value is RetryPolicy {
  if (!(value instanceof RetryPolicy)) {
    throw new TypeError('expected a RetryPolicy');
  }
}

// --- Task context -----------------------------------------------------------

export interface TaskContextInit {
  task: Task;
  upstream?: ReadonlyMap<string, Task>;
  signal: AbortSignal;
  isCancelled: () => boolean;
  emitter?: (percent: number | undefined, message: string | undefined) => void;
}

export class TaskContext {
  readonly #task: Task;
  readonly #upstream: ReadonlyMap<string, Task>;
  readonly #signal: AbortSignal;
  readonly #isCancelled: () => boolean;
  readonly #emitter:
    | ((percent: number | undefined, message: string | undefined) => void)
    | undefined;

  public constructor(init: TaskContextInit) {
    this.#task = init.task;
    // R-EXEC-10: defensively copy so later mutations don't affect handler.
    this.#upstream = new Map(init.upstream ?? new Map());
    this.#signal = init.signal;
    this.#isCancelled = init.isCancelled;
    this.#emitter = init.emitter;
  }

  public get id(): string {
    return this.#task.id;
  }
  public get title(): string {
    return this.#task.title;
  }
  public get description(): string {
    return this.#task.description;
  }
  public get payload(): string {
    return this.#task.payload;
  }
  public get type(): TaskType {
    return this.#task.type;
  }
  public get timeout(): number | undefined {
    return this.#task.timeout;
  }
  public get status(): TaskStatus {
    return this.#task.status;
  }
  public get task(): Task {
    return this.#task;
  }
  public get upstream(): ReadonlyMap<string, Task> {
    return this.#upstream;
  }
  public get signal(): AbortSignal {
    return this.#signal;
  }
  public get cancelled(): boolean {
    return this.#isCancelled();
  }

  public raiseIfCancelled(): void {
    if (this.#isCancelled()) throw new TaskCancelled();
  }

  // R-EXEC-11, R-EXEC-12
  public emitProgress(percent?: number, message?: string): void {
    if (this.#emitter === undefined) {
      throw new Error('TaskContext.emitProgress requires an executor-bound emitter');
    }
    if (this.#isCancelled()) throw new TaskCancelled();
    this.#emitter(percent, message);
  }
}

// --- Handler ----------------------------------------------------------------

export type TaskHandler = (context: TaskContext) => Promise<unknown> | unknown;

// --- Submitted handle -------------------------------------------------------

export interface SubmittedTask<T = TaskResult> extends Promise<T> {
  readonly task: Task;
  cancel(): void;
}

// --- Executor ---------------------------------------------------------------

const currentTaskIdStore = new AsyncLocalStorage<string>();

interface RunState {
  controller: AbortController;
  cancelled: boolean;
}

export interface ExecuteOptions {
  upstream?: ReadonlyMap<string, Task>;
  retryPolicy?: RetryPolicy;
  signal?: AbortSignal;
}

export interface PersistenceError {
  readonly taskId: string;
  readonly error: Error;
}

export interface GraphPersistenceError {
  readonly graphId: string;
  readonly error: Error;
}

export interface TaskExecutorOptions {
  store?: Store;
}

function makeCancelledResult(task: Task, at: Date): TaskResult {
  // R-EXEC-14: error="cancelled", terminationReason="cancelled", duration=0.
  return new TaskResult({
    taskId: task.id,
    status: TaskStatus.CANCELLED,
    startedAt: at,
    finishedAt: at,
    duration: 0,
    output: '',
    error: 'cancelled',
    raw: null,
    returncode: null,
    terminationReason: 'cancelled',
  });
}

export class TaskExecutor {
  public readonly events = new EventBus<TaskEvent>();
  public readonly store: Store | undefined;

  readonly #handlers = new Map<TaskType, TaskHandler>();
  readonly #running = new Map<string, RunState>();
  readonly #inflight = new Map<string, Promise<unknown>>();
  readonly #persistenceErrors: PersistenceError[] = [];
  readonly #graphPersistenceErrors: GraphPersistenceError[] = [];
  #shutdown = false;

  public constructor(options: TaskExecutorOptions = {}) {
    this.store = options.store;
  }

  // R-EXEC-03 seam: an executor with no handlers registered.
  public static empty(options: TaskExecutorOptions = {}): TaskExecutor {
    return new TaskExecutor(options);
  }

  public get isShutdown(): boolean {
    return this.#shutdown;
  }

  public get persistenceErrors(): readonly PersistenceError[] {
    return [...this.#persistenceErrors];
  }

  public get graphPersistenceErrors(): readonly GraphPersistenceError[] {
    return [...this.#graphPersistenceErrors];
  }

  // R-GRAPH-28: invoked by TaskGraph when graph save fails.
  public recordGraphPersistenceError(graphId: string, error: Error): void {
    this.#graphPersistenceErrors.push({ graphId, error });
  }

  public isRunning(taskId: string): boolean {
    return this.#running.has(taskId);
  }

  // R-EXEC-01, R-EXEC-02
  public register(type: TaskType, handler: TaskHandler): void {
    assertTaskType(type);
    assertCallable(handler, 'handler');
    this.#handlers.set(type, handler);
  }

  public isRegistered(type: TaskType): boolean {
    assertTaskType(type);
    return this.#handlers.has(type);
  }

  // --- execute ------------------------------------------------------------

  public async execute(task: Task, options: ExecuteOptions = {}): Promise<TaskResult> {
    assertTask(task);
    if (options.retryPolicy !== undefined) assertRetryPolicy(options.retryPolicy);
    const policy = options.retryPolicy ?? new RetryPolicy({ maxAttempts: 1 });

    // R-EXEC-07
    if (task.status === TaskStatus.CANCELLED) {
      throw new TaskCancelled('Task is already cancelled');
    }
    // R-EXEC-08
    if (!task.canTransitionTo(TaskStatus.RUNNING)) {
      throw new TaskExecutionError(
        `Task cannot transition to RUNNING from ${task.status}`,
      );
    }

    // R-EXEC-06 + R-EXEC-19: missing handler skips RUNNING and never retries.
    const handler = this.#handlers.get(task.type);
    if (handler === undefined) {
      return this.#terminalizeMissingHandler(task);
    }

    return this.#runWithRetries(task, handler, policy, options);
  }

  async #runWithRetries(
    task: Task,
    handler: TaskHandler,
    policy: RetryPolicy,
    options: ExecuteOptions,
  ): Promise<TaskResult> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      try {
        return await this.#runOneAttempt(task, handler, options);
      } catch (error) {
        lastError = error;
        // R-EXEC-18: cancellation is never retried.
        if (error instanceof TaskCancelled) throw error;
        // R-EXEC-17: retry only if attempts remain.
        if (attempt === policy.maxAttempts) throw error;
        // R-EXEC-20 / R-EXEC-21: cancel-aware backoff between attempts.
        if (policy.backoff > 0) {
          const interrupted = await this.#cancellableSleep(task, policy.backoff * 1000);
          if (interrupted) throw new TaskCancelled();
        } else if (task.status === TaskStatus.CANCELLED) {
          throw new TaskCancelled();
        }
      }
    }
    throw lastError instanceof Error ? lastError : new TaskExecutionError(String(lastError));
  }

  async #runOneAttempt(
    task: Task,
    handler: TaskHandler,
    options: ExecuteOptions,
  ): Promise<TaskResult> {
    const startedAt = new Date();
    const previousStatus = task.status;

    const controller = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const state: RunState = { controller, cancelled: false };
    this.#running.set(task.id, state);

    task.transitionTo(TaskStatus.RUNNING);
    this.events.emit(
      TaskEvents.started({ task, previousStatus, timestamp: startedAt }),
    );
    await this.#persist(task);

    const ctx = new TaskContext({
      task,
      upstream: options.upstream,
      signal: controller.signal,
      isCancelled: () => state.cancelled || controller.signal.aborted,
      emitter: (percent, message) => {
        this.events.emit(TaskEvents.progress({ task, percent, message }));
      },
    });

    let raw: unknown;
    let thrown: unknown;
    try {
      raw = await currentTaskIdStore.run(task.id, () => Promise.resolve(handler(ctx)));
    } catch (error) {
      thrown = error;
    } finally {
      this.#running.delete(task.id);
    }

    const finishedAt = new Date();
    const wasCancelled = state.cancelled || thrown instanceof TaskCancelled;

    if (wasCancelled) {
      const result = makeCancelledResult(task, finishedAt);
      task.transitionTo(TaskStatus.CANCELLED, { result });
      this.events.emit(
        TaskEvents.cancelled({
          task,
          previousStatus: TaskStatus.RUNNING,
          timestamp: finishedAt,
        }),
      );
      await this.#persist(task);
      throw thrown instanceof TaskCancelled ? thrown : new TaskCancelled();
    }

    if (thrown !== undefined) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      const result = normalizeTaskResult({
        taskId: task.id,
        status: TaskStatus.FAILED,
        startedAt,
        finishedAt,
        raw: null,
        terminationReason: 'handler',
      });
      task.transitionTo(TaskStatus.FAILED, { error: message, result });
      this.events.emit(
        TaskEvents.failed({
          task,
          previousStatus: TaskStatus.RUNNING,
          error: message,
          timestamp: finishedAt,
        }),
      );
      await this.#persist(task);
      throw thrown instanceof Error ? thrown : new TaskExecutionError(message);
    }

    const result = normalizeTaskResult({
      taskId: task.id,
      status: TaskStatus.SUCCEEDED,
      startedAt,
      finishedAt,
      raw,
    });
    task.transitionTo(TaskStatus.SUCCEEDED, { result });
    this.events.emit(
      TaskEvents.succeeded({
        task,
        previousStatus: TaskStatus.RUNNING,
        timestamp: finishedAt,
      }),
    );
    await this.#persist(task);
    return result;
  }

  async #terminalizeMissingHandler(task: Task): Promise<TaskResult> {
    const previousStatus = task.status;
    const at = new Date();
    const result = normalizeTaskResult({
      taskId: task.id,
      status: TaskStatus.FAILED,
      startedAt: at,
      finishedAt: at,
      raw: null,
      terminationReason: 'handler',
    });
    const error = new MissingHandlerError(task.type);
    task.transitionTo(TaskStatus.FAILED, { error: error.message, result });
    this.events.emit(
      TaskEvents.failed({
        task,
        previousStatus,
        error: error.message,
        timestamp: at,
      }),
    );
    await this.#persist(task);
    throw error;
  }

  // --- cancel -------------------------------------------------------------

  // R-EXEC-13, R-EXEC-14, R-EXEC-15
  public cancel(task: Task): void {
    assertTask(task);

    if (task.status === TaskStatus.SUCCEEDED) return;
    if (task.status === TaskStatus.CANCELLED) return;

    if (task.status === TaskStatus.RUNNING) {
      const state = this.#running.get(task.id);
      if (state !== undefined) {
        state.cancelled = true;
        state.controller.abort();
      }
      return;
    }

    // PENDING / FAILED / BLOCKED — terminalize directly.
    const previousStatus = task.status;
    const at = new Date();
    const result = makeCancelledResult(task, at);
    task.transitionTo(TaskStatus.CANCELLED, { result });
    this.events.emit(
      TaskEvents.cancelled({ task, previousStatus, timestamp: at }),
    );
    void this.#persist(task);
  }

  // R-EXEC-32
  public markBlocked(task: Task, parentId: string): void {
    assertTask(task);
    if (typeof parentId !== 'string' || parentId.length === 0) {
      throw new TypeError('parentId must be a non-empty string');
    }
    const previousStatus = task.status;
    task.transitionTo(TaskStatus.BLOCKED, { blockedBy: parentId });
    this.events.emit(TaskEvents.blocked({ task, previousStatus }));
    void this.#persist(task);
  }

  // --- submit -------------------------------------------------------------

  // R-EXEC-22, R-EXEC-23, R-EXEC-24
  public submit(task: Task, options: ExecuteOptions = {}): SubmittedTask {
    assertTask(task);
    if (options.retryPolicy !== undefined) assertRetryPolicy(options.retryPolicy);
    if (this.#shutdown) throw new ExecutorShutdownError();

    let queuedAborted = false;

    const promise: Promise<TaskResult> = (async () => {
      // Yield so the caller can observe `submit` before execution starts.
      await Promise.resolve();
      if (queuedAborted && task.status !== TaskStatus.RUNNING && !task.isSink) {
        this.cancel(task);
      }
      if (task.status === TaskStatus.CANCELLED) {
        throw new TaskCancelled();
      }
      return await this.execute(task, options);
    })();

    this.#inflight.set(task.id, promise);
    void promise.catch(() => undefined).finally(() => {
      this.#inflight.delete(task.id);
    });

    const handle = promise as SubmittedTask;
    Object.defineProperty(handle, 'task', { value: task, enumerable: true });
    handle.cancel = () => {
      // R-EXEC-24: only effective on queued (not RUNNING) tasks.
      if (task.status === TaskStatus.RUNNING) return;
      queuedAborted = true;
    };
    return handle;
  }

  // --- shutdown -----------------------------------------------------------

  // R-EXEC-25, R-EXEC-26
  public async shutdown(): Promise<void> {
    this.#shutdown = true;
    const callerTaskId = currentTaskIdStore.getStore();
    const drained: Promise<unknown>[] = [];
    for (const [id, promise] of this.#inflight) {
      if (id === callerTaskId) continue;
      drained.push(promise.catch(() => undefined));
    }
    await Promise.all(drained);
  }

  public async close(): Promise<void> {
    return this.shutdown();
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    return this.shutdown();
  }

  // --- internals ----------------------------------------------------------

  async #persist(task: Task): Promise<void> {
    if (this.store === undefined) return;
    try {
      await this.store.tasks.save(task);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.#persistenceErrors.push({ taskId: task.id, error: err });
      this.events.emit(
        TaskEvents.persistenceFailed({ task, error: err.message }),
      );
    }
  }

  async #cancellableSleep(task: Task, ms: number): Promise<boolean> {
    // R-EXEC-21: tick frequently so cancellation is honored within a small
    // bounded window even for long backoffs. Returns true if interrupted.
    const tickMs = 25;
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (task.status === TaskStatus.CANCELLED) return true;
      const remaining = deadline - Date.now();
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(tickMs, remaining)));
    }
    return task.status === TaskStatus.CANCELLED;
  }
}
