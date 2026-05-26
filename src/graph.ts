import { TaskExecutor } from './executor.js';
import { Task, TaskStatus } from './task.js';

export class TaskGraph {
  private readonly dependenciesByTask = new Map<Task, Task[]>();

  public add(task: Task, after: Iterable<Task> = []): this {
    this.dependenciesByTask.set(task, [...after]);
    return this;
  }

  public dependencies(task: Task): Task[] {
    return this.dependenciesByTask.get(task) ?? [];
  }

  public get tasks(): Task[] {
    return [...this.dependenciesByTask.keys()];
  }

  public async run(executor: TaskExecutor): Promise<this> {
    for (const task of this.tasks) {
      const deps = this.dependencies(task);
      const blocker = deps.find((dep) => dep.status !== TaskStatus.SUCCEEDED);
      if (blocker !== undefined) {
        task.transitionTo(TaskStatus.BLOCKED, { blockedBy: blocker.id });
        continue;
      }
      await executor.execute(task, {
        upstream: new Map(deps.map((dep) => [dep.id, dep])),
      });
    }
    return this;
  }
}
