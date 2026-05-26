import { randomUUID } from 'node:crypto';

export enum TaskStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  BLOCKED = 'blocked',
}

export enum TaskType {
  BASH = 'bash',
  POWERSHELL = 'powershell',
  PROMPT = 'prompt',
  AGENT = 'agent',
}

const VALID_TASK_TYPES: ReadonlySet<string> = new Set(Object.values(TaskType));

export type TerminationReason = null | 'exit_code' | 'timeout' | 'cancelled' | 'handler';

export interface TaskResultInit {
  taskId: string;
  status: TaskStatus;
  startedAt: Date;
  finishedAt: Date;
  duration: number;
  output: string;
  error: string | null;
  raw: unknown;
  returncode: number | null;
  terminationReason: TerminationReason;
}

export class TaskResult {
  public readonly taskId: string;
  public readonly status: TaskStatus;
  public readonly startedAt: Date;
  public readonly finishedAt: Date;
  public readonly duration: number;
  public readonly output: string;
  public readonly error: string | null;
  public readonly raw: unknown;
  public readonly returncode: number | null;
  public readonly terminationReason: TerminationReason;

  public constructor(init: TaskResultInit) {
    this.taskId = init.taskId;
    this.status = init.status;
    this.startedAt = init.startedAt;
    this.finishedAt = init.finishedAt;
    this.duration = init.duration;
    this.output = init.output;
    this.error = init.error;
    this.raw = init.raw;
    this.returncode = init.returncode;
    this.terminationReason = init.terminationReason;
    Object.freeze(this);
  }
}

interface SubprocessLike {
  stdout: string;
  stderr: string;
  returncode: number;
}

function isSubprocessLike(value: unknown): value is SubprocessLike {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.stdout === 'string' &&
    typeof v.stderr === 'string' &&
    typeof v.returncode === 'number'
  );
}

export interface NormalizeTaskResultInit {
  taskId: string;
  status: TaskStatus;
  startedAt: Date;
  finishedAt: Date;
  raw: unknown;
  terminationReason?: TerminationReason;
}

// R-TASK-14: normalize a handler's return value into a TaskResult.
export function normalizeTaskResult(init: NormalizeTaskResultInit): TaskResult {
  const duration = init.finishedAt.getTime() - init.startedAt.getTime();
  const terminationReason =
    init.terminationReason ?? (init.status === TaskStatus.SUCCEEDED ? null : 'handler');

  if (typeof init.raw === 'string') {
    return new TaskResult({
      taskId: init.taskId,
      status: init.status,
      startedAt: init.startedAt,
      finishedAt: init.finishedAt,
      duration,
      output: init.raw,
      error: null,
      raw: init.raw,
      returncode: null,
      terminationReason,
    });
  }

  if (isSubprocessLike(init.raw)) {
    return new TaskResult({
      taskId: init.taskId,
      status: init.status,
      startedAt: init.startedAt,
      finishedAt: init.finishedAt,
      duration,
      output: init.raw.stdout,
      error: init.raw.stderr === '' ? null : init.raw.stderr,
      raw: init.raw,
      returncode: init.raw.returncode,
      terminationReason,
    });
  }

  return new TaskResult({
    taskId: init.taskId,
    status: init.status,
    startedAt: init.startedAt,
    finishedAt: init.finishedAt,
    duration,
    output: '',
    error: null,
    raw: init.raw,
    returncode: null,
    terminationReason,
  });
}

export interface TaskInit {
  title?: string;
  description?: string;
  timeout?: number;
  id?: string;
}

const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, ReadonlySet<TaskStatus>>> = {
  [TaskStatus.PENDING]: new Set([
    TaskStatus.RUNNING,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
    TaskStatus.BLOCKED,
  ]),
  [TaskStatus.RUNNING]: new Set([
    TaskStatus.SUCCEEDED,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
  ]),
  [TaskStatus.SUCCEEDED]: new Set<TaskStatus>(),
  [TaskStatus.FAILED]: new Set([TaskStatus.RUNNING, TaskStatus.CANCELLED]),
  [TaskStatus.CANCELLED]: new Set<TaskStatus>(),
  [TaskStatus.BLOCKED]: new Set([TaskStatus.RUNNING, TaskStatus.CANCELLED]),
};

const SINK_STATES: ReadonlySet<TaskStatus> = new Set([
  TaskStatus.SUCCEEDED,
  TaskStatus.CANCELLED,
]);
const ACTIVE_STATES: ReadonlySet<TaskStatus> = new Set([
  TaskStatus.PENDING,
  TaskStatus.RUNNING,
]);
const BAD_STATES: ReadonlySet<TaskStatus> = new Set([
  TaskStatus.FAILED,
  TaskStatus.CANCELLED,
  TaskStatus.BLOCKED,
]);

export class InvalidTransitionError extends Error {
  public constructor(from: TaskStatus, to: TaskStatus) {
    super(`Invalid task transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export class TaskMutationError extends Error {
  public constructor(field: string) {
    super(`Cannot mutate '${field}' on a task that is not editable`);
    this.name = 'TaskMutationError';
  }
}

export interface TransitionOptions {
  result?: TaskResult;
  error?: string;
  blockedBy?: string;
}

function validateTimeout(timeout: number | undefined): void {
  if (timeout === undefined) return;
  if (!(typeof timeout === 'number') || Number.isNaN(timeout) || timeout <= 0) {
    throw new RangeError(`timeout must be a positive number, got ${String(timeout)}`);
  }
}

export class Task {
  readonly #id: string;
  readonly #type: TaskType;
  readonly #createdAt: Date;

  #title: string;
  #description: string;
  #payload: string;
  #timeout: number | undefined;

  #status: TaskStatus = TaskStatus.PENDING;
  #error: string | undefined;
  #result: TaskResult | undefined;
  #blockedBy: string | undefined;

  public constructor(type: TaskType, payload: string, init: TaskInit = {}) {
    // R-TASK-01: validate type at construction
    if (!VALID_TASK_TYPES.has(type as string)) {
      throw new TypeError(`Unknown task type: ${String(type)}`);
    }
    validateTimeout(init.timeout);

    this.#id = init.id ?? randomUUID();
    this.#type = type;
    this.#createdAt = new Date();
    this.#title = init.title ?? '';
    this.#description = init.description ?? '';
    this.#payload = payload;
    this.#timeout = init.timeout;
  }

  // --- Identity / immutable fields -----------------------------------------

  public get id(): string {
    return this.#id;
  }

  public get type(): TaskType {
    return this.#type;
  }

  public get createdAt(): Date {
    return this.#createdAt;
  }

  // --- Mutable-until-SUCCEEDED fields --------------------------------------

  public get title(): string {
    return this.#title;
  }

  public set title(value: string) {
    this.#assertEditable('title');
    this.#title = value;
  }

  public get description(): string {
    return this.#description;
  }

  public set description(value: string) {
    this.#assertEditable('description');
    this.#description = value;
  }

  public get payload(): string {
    return this.#payload;
  }

  public set payload(value: string) {
    this.#assertEditable('payload');
    this.#payload = value;
  }

  public get timeout(): number | undefined {
    return this.#timeout;
  }

  public set timeout(value: number | undefined) {
    this.#assertEditable('timeout');
    validateTimeout(value);
    this.#timeout = value;
  }

  public get error(): string | undefined {
    return this.#error;
  }

  public set error(value: string | undefined) {
    this.#assertEditable('error');
    this.#error = value;
  }

  // --- State-machine-managed fields (read-only externally) -----------------

  public get status(): TaskStatus {
    return this.#status;
  }

  public get result(): TaskResult | undefined {
    return this.#result;
  }

  public get blockedBy(): string | undefined {
    return this.#blockedBy;
  }

  // --- Predicates (R-SM-11) ------------------------------------------------

  public get isPending(): boolean {
    return this.#status === TaskStatus.PENDING;
  }
  public get isRunning(): boolean {
    return this.#status === TaskStatus.RUNNING;
  }
  public get isSucceeded(): boolean {
    return this.#status === TaskStatus.SUCCEEDED;
  }
  public get isFailed(): boolean {
    return this.#status === TaskStatus.FAILED;
  }
  public get isCancelled(): boolean {
    return this.#status === TaskStatus.CANCELLED;
  }
  public get isBlocked(): boolean {
    return this.#status === TaskStatus.BLOCKED;
  }
  public get isSink(): boolean {
    return SINK_STATES.has(this.#status);
  }
  public get isTerminal(): boolean {
    return SINK_STATES.has(this.#status);
  }
  public get isActive(): boolean {
    return ACTIVE_STATES.has(this.#status);
  }
  public get isBad(): boolean {
    return BAD_STATES.has(this.#status);
  }

  // --- Transitions ---------------------------------------------------------

  public canTransitionTo(target: TaskStatus): boolean {
    const allowed = ALLOWED_TRANSITIONS[this.#status];
    return allowed?.has(target) ?? false;
  }

  // R-SM-01..06, R-SM-08: state-machine entry point.
  public transitionTo(target: TaskStatus, opts: TransitionOptions = {}): void {
    if (!this.canTransitionTo(target)) {
      // R-SM-01: reject without mutating status, error, or result.
      throw new InvalidTransitionError(this.#status, target);
    }

    switch (target) {
      case TaskStatus.RUNNING:
        // R-SM-03: clear prior-run carryover.
        this.#result = undefined;
        this.#blockedBy = undefined;
        this.#error = undefined;
        break;
      case TaskStatus.SUCCEEDED:
        // R-SM-04: clear error even if explicitly supplied.
        this.#error = undefined;
        if (opts.result !== undefined) this.#result = opts.result;
        break;
      case TaskStatus.FAILED:
        // R-SM-05: preserve supplied error for inspection.
        if (opts.error !== undefined) this.#error = opts.error;
        if (opts.result !== undefined) this.#result = opts.result;
        break;
      case TaskStatus.CANCELLED:
        // R-SM-06: do not erase prior error.
        if (opts.result !== undefined) this.#result = opts.result;
        break;
      case TaskStatus.BLOCKED:
        // R-TASK-12: BLOCKED has no result.
        if (opts.blockedBy !== undefined) this.#blockedBy = opts.blockedBy;
        break;
      case TaskStatus.PENDING:
        // Not reachable: PENDING has no inbound edges.
        break;
    }

    this.#status = target;
  }

  // R-SM-07: idempotent cancel.
  public cancel(opts: TransitionOptions = {}): void {
    if (this.isSink) return;
    this.transitionTo(TaskStatus.CANCELLED, opts);
  }

  // --- R-TASK-15: identity-first display -----------------------------------

  public toString(): string {
    return `Task(id=${this.#id}, title=${JSON.stringify(this.#title)}, status=${this.#status})`;
  }

  // --- Factories (R-TASK-11) ----------------------------------------------

  public static bash(payload: string, init: TaskInit = {}): Task {
    return new Task(TaskType.BASH, payload, init);
  }

  public static powershell(payload: string, init: TaskInit = {}): Task {
    return new Task(TaskType.POWERSHELL, payload, init);
  }

  public static prompt(payload: string, init: TaskInit = {}): Task {
    return new Task(TaskType.PROMPT, payload, init);
  }

  public static agent(payload: string, init: TaskInit = {}): Task {
    return new Task(TaskType.AGENT, payload, init);
  }

  // --- Internals -----------------------------------------------------------

  #assertEditable(field: string): void {
    // R-SM-09: SUCCEEDED tasks reject public mutation of these fields.
    if (this.#status === TaskStatus.SUCCEEDED) {
      throw new TaskMutationError(field);
    }
  }
}
