import { describe, expect, it } from 'vitest';

import { TaskExecutor } from '../src/executor.js';
import { SqliteStore } from '../src/store-sqlite.js';
import { Task, TaskStatus, TaskType } from '../src/task.js';

// Compile-time shape assertions for the open TaskType. If these stop
// compiling, the public ergonomics for issue #1 have regressed.
const _shapes = (): void => {
  new Task('webhook', '{}');
  new Task(TaskType.BASH, '{}');
  Task.custom('notification', '{}', { title: 'n' });

  const exec = new TaskExecutor();
  exec.register('webhook', () => 'ok');
  exec.register(TaskType.BASH, () => 'ok');
  void exec.isRegistered('webhook');
};
void _shapes;

describe('Issue #1 — open TaskType for custom kinds', () => {
  it('end-to-end: register custom handler and execute a custom task', async () => {
    const exec = new TaskExecutor();
    const seen: string[] = [];
    exec.register('webhook', (ctx) => {
      seen.push(ctx.payload);
      return 'fired';
    });

    const t = Task.custom('webhook', '{"url":"https://example.com"}', {
      title: 'notify foo',
    });
    const result = await exec.execute(t);

    expect(t.type).toBe('webhook');
    expect(result.status).toBe(TaskStatus.SUCCEEDED);
    expect(result.output).toBe('fired');
    expect(seen).toEqual(['{"url":"https://example.com"}']);
  });

  it('R-TASK-01a: SqliteStore round-trips custom task types unchanged', () => {
    const store = new SqliteStore({ path: ':memory:' });
    try {
      const t = new Task('notification', '{"to":"user"}', {
        title: 'ping',
      });
      store.tasks.save(t);

      const reloaded = store.tasks.get(t.id)!;
      expect(reloaded.type).toBe('notification');
      expect(reloaded.title).toBe('ping');
      expect(reloaded.payload).toBe('{"to":"user"}');
    } finally {
      store.close();
    }
  });

  it('executor reports false for valid but unregistered custom types', () => {
    const exec = new TaskExecutor();
    expect(exec.isRegistered('never-registered')).toBe(false);
    exec.register('agent-handoff', () => 'ok');
    expect(exec.isRegistered('agent-handoff')).toBe(true);
  });
});
