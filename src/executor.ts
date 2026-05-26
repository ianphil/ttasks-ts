import { EventBus, TaskEventType, type TaskEvent } from './events.js';
import { Task, TaskResult, TaskStatus, type TaskType } from './task.js';

export class TaskExecutionError extends Error {}
export class TaskTimeoutError extends TaskExecutionError {}
export class TaskCancelled extends TaskExecutionError {}

export interface RetryPolicy {
  maxAttempts: number;
  backoff?: number;
}

export interface TaskContext {
  task: Task;
  upstream: ReadonlyMap<string, Task>;
}

export type TaskHandler = (context: TaskContext) => Promise<unknown> | unknown;

export class TaskExecutor {
  public readonly events = new EventBus<TaskEvent>();
  private readonly handlers = new Map<TaskType, TaskHandler>();

  public register(type: TaskType, handler: TaskHandler): void {
    this.handlers.set(type, handler);
  }

  public async execute(task: Task, upstream: ReadonlyMap<string, Task> = new Map()): Promise<TaskResult> {
    const startedAt = new Date();
    task.status = TaskStatus.RUNNING;
    this.events.emit({
      type: TaskEventType.STARTED,
      task,
      taskId: task.id,
      timestamp: startedAt,
      previousStatus: TaskStatus.PENDING,
      status: TaskStatus.RUNNING,
    });

    const handler = this.handlers.get(task.type);
    if (handler === undefined) {
      task.status = TaskStatus.FAILED;
      const error = `No handler registered for task type '${task.type}'`;
      const finishedAt = new Date();
      const result = new TaskResult(
        task.id,
        TaskStatus.FAILED,
        startedAt,
        finishedAt,
        finishedAt.getTime() - startedAt.getTime(),
        undefined,
        error,
      );
      task.result = result;
      this.events.emit({
        type: TaskEventType.FAILED,
        task,
        taskId: task.id,
        timestamp: finishedAt,
        previousStatus: TaskStatus.RUNNING,
        status: TaskStatus.FAILED,
        error,
      });
      throw new TaskExecutionError(error);
    }

    try {
      const raw = await handler({ task, upstream });
      const finishedAt = new Date();
      const output = typeof raw === 'string' ? raw : undefined;
      task.status = TaskStatus.SUCCEEDED;
      const result = new TaskResult(
        task.id,
        TaskStatus.SUCCEEDED,
        startedAt,
        finishedAt,
        finishedAt.getTime() - startedAt.getTime(),
        output,
        undefined,
        raw,
      );
      task.result = result;
      this.events.emit({
        type: TaskEventType.SUCCEEDED,
        task,
        taskId: task.id,
        timestamp: finishedAt,
        previousStatus: TaskStatus.RUNNING,
        status: TaskStatus.SUCCEEDED,
      });
      return result;
    } catch (error) {
      const finishedAt = new Date();
      const message = error instanceof Error ? error.message : String(error);
      task.status = TaskStatus.FAILED;
      task.error = message;
      const result = new TaskResult(
        task.id,
        TaskStatus.FAILED,
        startedAt,
        finishedAt,
        finishedAt.getTime() - startedAt.getTime(),
        undefined,
        message,
        undefined,
      );
      task.result = result;
      this.events.emit({
        type: TaskEventType.FAILED,
        task,
        taskId: task.id,
        timestamp: finishedAt,
        previousStatus: TaskStatus.RUNNING,
        status: TaskStatus.FAILED,
        error: message,
      });
      throw error;
    }
  }
}
