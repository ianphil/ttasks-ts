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
  CUSTOM = 'custom',
}

export interface TaskInit {
  title?: string;
  description?: string;
  timeout?: number;
  id?: string;
}

export class TaskResult {
  public constructor(
    public readonly taskId: string,
    public readonly status: TaskStatus,
    public readonly startedAt: Date,
    public readonly finishedAt: Date,
    public readonly duration: number,
    public readonly output?: string,
    public readonly error?: string,
    public readonly raw?: unknown,
    public readonly returncode?: number,
    public readonly terminationReason?: string,
  ) {}
}

export class Task {
  public readonly id: string;
  public title: string;
  public description: string;
  public payload: string;
  public readonly type: TaskType;
  public timeout?: number;
  public status: TaskStatus = TaskStatus.PENDING;
  public error?: string;
  public result?: TaskResult;
  public blockedBy?: string;

  public constructor(type: TaskType, payload: string, init: TaskInit = {}) {
    this.id = init.id ?? randomUUID();
    this.title = init.title ?? '';
    this.description = init.description ?? '';
    this.payload = payload;
    this.type = type;
    this.timeout = init.timeout;
  }

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
}
