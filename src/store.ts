import type { Task } from './task.js';
import { TaskGraph } from './graph.js';

export interface TaskStore {
  save(task: Task): void | Promise<void>;
  get(taskId: string): Task | undefined | Promise<Task | undefined>;
  has(taskOrId: Task | string): boolean | Promise<boolean>;
  delete(taskOrId: Task | string): void | Promise<void>;
}

export interface GraphStore {
  save(graph: TaskGraph): void | Promise<void>;
  get(graphId: string): TaskGraph | undefined | Promise<TaskGraph | undefined>;
  has(graphOrId: TaskGraph | string): boolean | Promise<boolean>;
  delete(graphOrId: TaskGraph | string): void | Promise<void>;
}

export interface Store {
  tasks: TaskStore;
  graphs: GraphStore;
}

class InMemoryTaskCollection implements TaskStore {
  readonly #items = new Map<string, Task>();

  public save(task: Task): void {
    this.#items.set(task.id, task);
  }

  public get(taskId: string): Task | undefined {
    return this.#items.get(taskId);
  }

  public has(taskOrId: Task | string): boolean {
    const id = typeof taskOrId === 'string' ? taskOrId : taskOrId.id;
    return this.#items.has(id);
  }

  public delete(taskOrId: Task | string): void {
    const id = typeof taskOrId === 'string' ? taskOrId : taskOrId.id;
    this.#items.delete(id);
  }

  public *[Symbol.iterator](): IterableIterator<Task> {
    yield* this.#items.values();
  }

  public get size(): number {
    return this.#items.size;
  }
}

class InMemoryGraphCollection implements GraphStore {
  readonly #items = new Map<string, TaskGraph>();

  public save(graph: TaskGraph): void {
    // TaskGraph does not yet expose `id`; fall back to object identity key.
    const id = (graph as unknown as { id?: string }).id ?? '';
    this.#items.set(id, graph);
  }

  public get(graphId: string): TaskGraph | undefined {
    return this.#items.get(graphId);
  }

  public has(graphOrId: TaskGraph | string): boolean {
    const id =
      typeof graphOrId === 'string'
        ? graphOrId
        : ((graphOrId as unknown as { id?: string }).id ?? '');
    return this.#items.has(id);
  }

  public delete(graphOrId: TaskGraph | string): void {
    const id =
      typeof graphOrId === 'string'
        ? graphOrId
        : ((graphOrId as unknown as { id?: string }).id ?? '');
    this.#items.delete(id);
  }
}

export class InMemoryStore implements Store {
  public readonly tasks = new InMemoryTaskCollection();
  public readonly graphs = new InMemoryGraphCollection();
}
