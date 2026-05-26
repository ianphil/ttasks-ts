import { Task } from './task.js';
import { TaskGraph } from './graph.js';

// R-STORE-07: this implementation chooses `get(id) -> T | undefined`
// (no throw) as the documented "missing key" surface. `delete` and
// explicit setItem follow R-STORE-04..09 and throw structured errors.

export class StoreKeyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'StoreKeyError';
  }
}

export class StoreIdMismatchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'StoreIdMismatchError';
  }
}

// --- Protocols --------------------------------------------------------------

export interface TaskStore {
  readonly size: number;
  save(task: Task): void | Promise<void>;
  setItem(id: string, task: Task): void;
  get(id: string): Task | undefined;
  has(key: unknown): boolean;
  delete(key: string | Task): void;
  ids(): IterableIterator<string>;
  values(): IterableIterator<Task>;
  [Symbol.iterator](): IterableIterator<string>;
}

export interface GraphStore {
  readonly size: number;
  save(graph: TaskGraph): void | Promise<void>;
  setItem(id: string, graph: TaskGraph): void;
  get(id: string): TaskGraph | undefined;
  has(key: unknown): boolean;
  delete(key: string | TaskGraph): void;
  ids(): IterableIterator<string>;
  values(): IterableIterator<TaskGraph>;
  [Symbol.iterator](): IterableIterator<string>;
}

export interface Store {
  tasks: TaskStore;
  graphs: GraphStore;
}

// --- In-memory backend ------------------------------------------------------

export class InMemoryTaskCollection implements TaskStore {
  // R-STORE-10: JS Map preserves insertion order.
  readonly #items = new Map<string, Task>();

  public get size(): number {
    return this.#items.size;
  }

  // R-STORE-03
  public save(task: Task): void {
    if (!(task instanceof Task)) {
      throw new TypeError('save expects a Task');
    }
    // R-STORE-11: live references — store the exact instance.
    this.#items.set(task.id, task);
  }

  // R-STORE-04, R-STORE-05
  public setItem(id: string, task: Task): void {
    if (!(task instanceof Task)) {
      throw new TypeError('value must be a Task');
    }
    if (id !== task.id) {
      throw new StoreIdMismatchError(`id mismatch: ${id} !== task.id ${task.id}`);
    }
    this.#items.set(id, task);
  }

  // R-STORE-07
  public get(id: string): Task | undefined {
    return this.#items.get(id);
  }

  // R-STORE-08: accepts id or Task, never throws.
  public has(key: unknown): boolean {
    if (typeof key === 'string') return this.#items.has(key);
    if (key instanceof Task) return this.#items.get(key.id) === key;
    return false;
  }

  // R-STORE-09
  public delete(key: string | Task): void {
    const id = key instanceof Task ? key.id : key;
    if (typeof id !== 'string' || !this.#items.has(id)) {
      throw new StoreKeyError(`no such task: ${String(id)}`);
    }
    this.#items.delete(id);
  }

  public ids(): IterableIterator<string> {
    return this.#items.keys();
  }

  public values(): IterableIterator<Task> {
    return this.#items.values();
  }

  public [Symbol.iterator](): IterableIterator<string> {
    return this.#items.keys();
  }

  // R-STORE-12: convenience cancel.
  public cancel(id: string): void {
    const task = this.#items.get(id);
    if (task === undefined) {
      throw new StoreKeyError(`no such task: ${id}`);
    }
    task.cancel();
  }
}

export class InMemoryGraphCollection implements GraphStore {
  readonly #items = new Map<string, TaskGraph>();

  public get size(): number {
    return this.#items.size;
  }

  public save(graph: TaskGraph): void {
    if (!(graph instanceof TaskGraph)) {
      throw new TypeError('save expects a TaskGraph');
    }
    this.#items.set(graph.id, graph);
  }

  public setItem(id: string, graph: TaskGraph): void {
    if (!(graph instanceof TaskGraph)) {
      throw new TypeError('value must be a TaskGraph');
    }
    if (id !== graph.id) {
      throw new StoreIdMismatchError(`id mismatch: ${id} !== graph.id ${graph.id}`);
    }
    this.#items.set(id, graph);
  }

  public get(id: string): TaskGraph | undefined {
    return this.#items.get(id);
  }

  public has(key: unknown): boolean {
    if (typeof key === 'string') return this.#items.has(key);
    if (key instanceof TaskGraph) return this.#items.get(key.id) === key;
    return false;
  }

  public delete(key: string | TaskGraph): void {
    const id = key instanceof TaskGraph ? key.id : key;
    if (typeof id !== 'string' || !this.#items.has(id)) {
      throw new StoreKeyError(`no such graph: ${String(id)}`);
    }
    this.#items.delete(id);
  }

  public ids(): IterableIterator<string> {
    return this.#items.keys();
  }

  public values(): IterableIterator<TaskGraph> {
    return this.#items.values();
  }

  public [Symbol.iterator](): IterableIterator<string> {
    return this.#items.keys();
  }
}

// R-STORE-01
export class InMemoryStore implements Store {
  public readonly tasks = new InMemoryTaskCollection();
  public readonly graphs = new InMemoryGraphCollection();
}
