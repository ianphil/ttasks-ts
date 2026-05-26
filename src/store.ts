import { Task } from './task.js';
import { TaskGraph } from './graph.js';

export class InMemoryStore {
  public readonly tasks = new Map<string, Task>();
  public readonly graphs = new Map<string, TaskGraph>();
}
