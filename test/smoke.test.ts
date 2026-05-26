import { describe, expect, it } from 'vitest';

import { Task, TaskExecutor, TaskGraph, TaskStatus, TaskType } from '../src/index.js';

describe('ttasks-ts scaffold', () => {
  it('creates bash tasks via the factory', () => {
    const task = Task.bash('echo hi', { title: 'Say hi' });

    expect(task.type).toBe(TaskType.BASH);
    expect(task.title).toBe('Say hi');
    expect(task.status).toBe(TaskStatus.PENDING);
  });

  it('executes a registered handler', async () => {
    const executor = new TaskExecutor();
    const task = Task.bash('echo hi');
    executor.register(TaskType.BASH, () => 'ok');

    const result = await executor.execute(task);

    expect(result.output).toBe('ok');
    expect(task.status).toBe(TaskStatus.SUCCEEDED);
  });

  it('runs a tiny dependency graph', async () => {
    const executor = new TaskExecutor();
    executor.register(TaskType.BASH, ({ task }) => task.title || 'ok');

    const a = Task.bash('', { title: 'A' });
    const b = Task.bash('', { title: 'B' });
    const graph = new TaskGraph();
    graph.add(a);
    graph.add(b, [a]);

    await graph.run(executor);

    expect(a.status).toBe(TaskStatus.SUCCEEDED);
    expect(b.status).toBe(TaskStatus.SUCCEEDED);
  });
});
