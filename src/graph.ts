import { randomUUID } from 'node:crypto';

import type { TaskExecutor } from './executor.js';
import { Task, TaskStatus } from './task.js';

export interface TaskGraphInit {
  id?: string;
  title?: string;
  createdAt?: Date;
}

// R-STORE-15: snapshot used to reconstruct a graph from a durable store.
export interface TaskGraphSnapshot {
  id: string;
  title: string;
  createdAt: Date;
  entries: ReadonlyArray<{
    task: Task;
    after: ReadonlyArray<string>;
    isFinally: boolean;
    required: boolean;
  }>;
}

export interface AddOptions {
  after?: Iterable<Task>;
  finally_?: boolean;
  required?: boolean;
}

export interface RunOptions {
  maxWorkers?: number;
}

export class GraphValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GraphValidationError';
  }
}

export class GraphCycleError extends GraphValidationError {
  public constructor(message: string) {
    super(message);
    this.name = 'GraphCycleError';
  }
}

export class GraphNoProgressError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'GraphNoProgressError';
  }
}

interface TaskMeta {
  readonly task: Task;
  deps: Task[];
  isFinally: boolean;
  required: boolean;
}

const DEFAULT_MAX_WORKERS = 4;

export class TaskGraph {
  public readonly id: string;
  public readonly createdAt: Date;
  #title: string;

  readonly #byId = new Map<string, TaskMeta>();
  readonly #order: string[] = [];
  #errors = new Map<string, Error>();
  #hasBeenRun = false;

  public constructor(init: TaskGraphInit = {}) {
    if (init.title !== undefined && typeof init.title !== 'string') {
      throw new TypeError('title must be a string');
    }
    this.id = init.id ?? randomUUID();
    this.#title = init.title ?? '';
    this.createdAt = init.createdAt ?? new Date();
  }

  // R-STORE-15: rebuild a graph from a durable snapshot.
  public static restore(snapshot: TaskGraphSnapshot): TaskGraph {
    const g = new TaskGraph({
      id: snapshot.id,
      title: snapshot.title,
      createdAt: snapshot.createdAt,
    });
    const byId = new Map<string, Task>();
    for (const e of snapshot.entries) byId.set(e.task.id, e.task);
    for (const e of snapshot.entries) {
      const after = e.after.map((id) => {
        const t = byId.get(id);
        if (t === undefined) {
          throw new Error(`restore: unknown dependency id ${id}`);
        }
        return t;
      });
      g.add(e.task, {
        after,
        finally_: e.isFinally,
        required: e.required,
      });
    }
    return g;
  }

  public get title(): string {
    return this.#title;
  }

  public set title(value: string) {
    if (typeof value !== 'string') throw new TypeError('title must be a string');
    this.#title = value;
  }

  // --- registration -------------------------------------------------------

  public add(task: Task, optionsOrAfter: AddOptions | Iterable<Task> = {}): this {
    // R-GRAPH-04
    if (!(task instanceof Task)) {
      throw new TypeError('add expects a Task');
    }
    const options: AddOptions =
      optionsOrAfter !== null &&
      typeof optionsOrAfter === 'object' &&
      Symbol.iterator in (optionsOrAfter as object)
        ? { after: optionsOrAfter as Iterable<Task> }
        : (optionsOrAfter as AddOptions);
    const after = options.after === undefined ? [] : [...options.after];
    for (const dep of after) {
      if (!(dep instanceof Task)) {
        throw new TypeError('dependency must be a Task');
      }
    }
    // R-GRAPH-06
    const finally_ = options.finally_ ?? false;
    const required = options.required ?? true;
    if (typeof finally_ !== 'boolean') throw new TypeError('finally_ must be a boolean');
    if (typeof required !== 'boolean') throw new TypeError('required must be a boolean');
    if (!required && !finally_) {
      throw new TypeError('required=false requires finally_=true');
    }

    // R-GRAPH-05: dedup preserving first appearance.
    const seen = new Set<string>();
    const deps: Task[] = [];
    for (const dep of after) {
      if (!seen.has(dep.id)) {
        seen.add(dep.id);
        deps.push(dep);
      }
    }

    const existing = this.#byId.get(task.id);
    if (existing === undefined) {
      this.#byId.set(task.id, { task, deps, isFinally: finally_, required });
      this.#order.push(task.id);
    } else {
      existing.deps = deps;
      existing.isFinally = finally_;
      existing.required = required;
    }
    return this;
  }

  // --- topology -----------------------------------------------------------

  public get tasks(): Task[] {
    return this.#order.map((id) => this.#byId.get(id)!.task);
  }

  public dependencies(task: Task): Task[] {
    return [...(this.#byId.get(task.id)?.deps ?? [])];
  }

  public isFinally(task: Task): boolean {
    return this.#byId.get(task.id)?.isFinally ?? false;
  }

  public isOptional(task: Task): boolean {
    const m = this.#byId.get(task.id);
    return m !== undefined && m.isFinally && !m.required;
  }

  public get finallyTasks(): Task[] {
    return this.#orderedFiltered((m) => m.isFinally);
  }

  public get optionalTasks(): Task[] {
    return this.#orderedFiltered((m) => m.isFinally && !m.required);
  }

  public get requiredTasks(): Task[] {
    return this.#orderedFiltered((m) => m.required);
  }

  public roots(): Task[] {
    return this.#orderedFiltered((m) => m.deps.length === 0);
  }

  public leaves(): Task[] {
    const hasDependent = new Set<string>();
    for (const m of this.#byId.values()) {
      for (const d of m.deps) hasDependent.add(d.id);
    }
    return this.#orderedFiltered((m) => !hasDependent.has(m.task.id));
  }

  // --- status views -------------------------------------------------------

  public get succeeded(): Task[] {
    return this.#withStatus(TaskStatus.SUCCEEDED);
  }
  public get failed(): Task[] {
    return this.#withStatus(TaskStatus.FAILED);
  }
  public get cancelled(): Task[] {
    return this.#withStatus(TaskStatus.CANCELLED);
  }
  public get blocked(): Task[] {
    return this.#withStatus(TaskStatus.BLOCKED);
  }
  public get optionalFailed(): Task[] {
    return this.failed.filter((t) => this.isOptional(t));
  }
  public get requiredFailed(): Task[] {
    return this.failed.filter((t) => !this.isOptional(t));
  }
  public get requiredBlocked(): Task[] {
    return this.blocked.filter((t) => !this.isOptional(t));
  }

  public get errors(): ReadonlyMap<string, Error> {
    return new Map(this.#errors);
  }

  // R-GRAPH-27
  public get ok(): boolean {
    if (this.#byId.size === 0) return this.#hasBeenRun || true;
    if (!this.#hasBeenRun) return false;
    for (const m of this.#byId.values()) {
      if (!m.required) continue;
      if (m.task.status !== TaskStatus.SUCCEEDED) return false;
      if (this.#errors.has(m.task.id)) return false;
    }
    return true;
  }

  // --- run ----------------------------------------------------------------

  public async run(executor: TaskExecutor, options: RunOptions = {}): Promise<this> {
    const maxWorkers = options.maxWorkers ?? DEFAULT_MAX_WORKERS;
    // R-GRAPH-10
    if (!Number.isFinite(maxWorkers) || maxWorkers <= 0) {
      throw new GraphValidationError(`maxWorkers must be > 0, got ${maxWorkers}`);
    }

    this.#validateForRun();

    // R-GRAPH-23
    this.#errors = new Map();
    this.#hasBeenRun = true;

    // R-GRAPH-28 (start)
    await this.#persistGraph(executor);

    try {
      await this.#schedule(executor, maxWorkers);
    } finally {
      // R-GRAPH-28 (end)
      await this.#persistGraph(executor);
    }
    return this;
  }

  // --- internals ----------------------------------------------------------

  #orderedFiltered(pred: (m: TaskMeta) => boolean): Task[] {
    return this.#order
      .map((id) => this.#byId.get(id)!)
      .filter(pred)
      .map((m) => m.task);
  }

  #withStatus(status: TaskStatus): Task[] {
    return this.#orderedFiltered((m) => m.task.status === status);
  }

  #validateForRun(): void {
    // R-GRAPH-11: deps must be registered.
    for (const m of this.#byId.values()) {
      for (const d of m.deps) {
        if (!this.#byId.has(d.id)) {
          throw new GraphValidationError(
            `task ${m.task.id} depends on unregistered task ${d.id}`,
          );
        }
      }
    }
    // R-GRAPH-13: no stale RUNNING.
    for (const m of this.#byId.values()) {
      if (m.task.status === TaskStatus.RUNNING) {
        throw new GraphValidationError(
          `task ${m.task.id} is RUNNING; cannot start a graph run`,
        );
      }
    }
    // R-GRAPH-12: cycle detection (DFS).
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    for (const id of this.#order) color.set(id, WHITE);
    const stack: string[] = [];
    const visit = (id: string): void => {
      const c = color.get(id);
      if (c === GRAY) {
        throw new GraphCycleError(
          `cycle detected involving task ${id}: ${[...stack, id].join(' -> ')}`,
        );
      }
      if (c === BLACK) return;
      color.set(id, GRAY);
      stack.push(id);
      const m = this.#byId.get(id)!;
      for (const dep of m.deps) visit(dep.id);
      stack.pop();
      color.set(id, BLACK);
    };
    for (const id of this.#order) visit(id);
  }

  async #persistGraph(executor: TaskExecutor): Promise<void> {
    const store = executor.store;
    if (store === undefined) return;
    try {
      await store.graphs.save(this);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      executor.recordGraphPersistenceError(this.id, err);
    }
  }

  async #schedule(executor: TaskExecutor, maxWorkers: number): Promise<void> {
    // Per-run scheduler state.
    type Outcome = { taskId: string; error?: Error };
    const inFlight = new Map<string, Promise<Outcome>>();
    const inRunBlocked = new Set<string>();
    // Pending = tasks not yet terminalized this run AND not currently inFlight.
    // Tasks already SUCCEEDED at run start count as satisfied (R-GRAPH-21).
    const pending = new Set<string>();
    for (const m of this.#byId.values()) {
      if (m.task.status !== TaskStatus.SUCCEEDED) pending.add(m.task.id);
    }

    const allParentsSucceeded = (m: TaskMeta): boolean =>
      m.deps.every((d) => d.status === TaskStatus.SUCCEEDED);

    const allParentsInactive = (m: TaskMeta): boolean =>
      m.deps.every((d) =>
        d.status === TaskStatus.SUCCEEDED ||
        d.status === TaskStatus.FAILED ||
        d.status === TaskStatus.CANCELLED ||
        d.status === TaskStatus.BLOCKED,
      );

    const isBadParent = (p: Task): boolean => {
      if (p.status === TaskStatus.FAILED) return true;
      if (p.status === TaskStatus.CANCELLED) return true;
      if (p.status === TaskStatus.BLOCKED && inRunBlocked.has(p.id)) return true;
      return false;
    };

    const launch = (m: TaskMeta): void => {
      pending.delete(m.task.id);
      const upstream = new Map(m.deps.map((d) => [d.id, d]));
      const p: Promise<Outcome> = executor
        .execute(m.task, { upstream })
        .then(() => ({ taskId: m.task.id }))
        .catch((error: unknown) => ({
          taskId: m.task.id,
          error: error instanceof Error ? error : new Error(String(error)),
        }));
      inFlight.set(m.task.id, p);
    };

    while (pending.size > 0 || inFlight.size > 0) {
      let progressed = false;

      // 1) Mark normal tasks with bad parents as BLOCKED.
      for (const id of [...pending]) {
        const m = this.#byId.get(id)!;
        if (m.isFinally) continue;
        const bad = m.deps.find(isBadParent);
        if (bad !== undefined) {
          executor.markBlocked(m.task, bad.id);
          inRunBlocked.add(m.task.id);
          pending.delete(id);
          progressed = true;
        }
      }

      // 2) Launch ready tasks up to maxWorkers.
      for (const id of [...pending]) {
        if (inFlight.size >= maxWorkers) break;
        const m = this.#byId.get(id)!;
        const ready = m.isFinally ? allParentsInactive(m) : allParentsSucceeded(m);
        if (ready) {
          launch(m);
          progressed = true;
        }
      }

      if (inFlight.size === 0) {
        if (pending.size === 0) break;
        if (!progressed) {
          // R-GRAPH-19
          const stuck = [...pending].join(', ');
          throw new GraphNoProgressError(
            `graph run made no progress; stuck tasks: ${stuck}`,
          );
        }
        continue;
      }

      // 3) Wait for at least one in-flight task to finish.
      const settled = await Promise.race(inFlight.values());
      inFlight.delete(settled.taskId);
      if (settled.error !== undefined) {
        // R-GRAPH-26
        this.#errors.set(settled.taskId, settled.error);
      }
    }
  }
}
