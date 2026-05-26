import type { Task, TaskStatus } from './task.js';

export enum TaskEventType {
  STARTED = 'started',
  SUCCEEDED = 'succeeded',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  BLOCKED = 'blocked',
  PROGRESS = 'progress',
  OUTPUT = 'output',
}

export interface TaskEvent {
  type: TaskEventType;
  task: Task;
  taskId: string;
  timestamp: Date;
  previousStatus?: TaskStatus;
  status?: TaskStatus;
  error?: string;
  progressPercent?: number;
  progressMessage?: string;
  outputStream?: 'stdout' | 'stderr';
  outputChunk?: string;
}

export type EventHandler<T> = (event: T) => void;

export class EventBus<T> {
  private readonly subscribers = new Set<EventHandler<T>>();
  public readonly errors: Error[] = [];

  public subscribe(handler: EventHandler<T>): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  public emit(event: T): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (error) {
        this.errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}
