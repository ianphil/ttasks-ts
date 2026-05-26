import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskEventType } from '../src/events.js';
import { TaskExecutor } from '../src/executor.js';
import { TaskGraph, GraphValidationError } from '../src/graph.js';
import { createBashHandler } from '../src/handlers/index.js';
import {
  SqliteStore,
  StoreSchemaMismatchError,
} from '../src/store-sqlite.js';
import {
  Task,
  TaskResult,
  TaskStatus,
  TaskType,
} from '../src/task.js';

let tmp: string;
let dbCounter = 0;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ttasks-sqlite-'));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const newDbPath = (): string => join(tmp, `db-${++dbCounter}.sqlite`);

function makeResultFor(task: Task): TaskResult {
  const start = new Date('2024-01-01T00:00:00.000Z');
  const end = new Date('2024-01-01T00:00:01.500Z');
  return new TaskResult({
    taskId: task.id,
    status: TaskStatus.SUCCEEDED,
    startedAt: start,
    finishedAt: end,
    duration: 1.5,
    output: 'hello\n',
    error: null,
    raw: { some: 'subprocess record' },
    returncode: 0,
    terminationReason: 'exit_code',
  });
}

describe('SqliteStore — R-STORE-13 detached snapshots', () => {
  it('returns a freshly reconstructed Task on every read', () => {
    const store = new SqliteStore({ path: ':memory:' });
    const task = Task.bash('echo hi', { title: 'greet' });
    store.tasks.save(task);

    const a = store.tasks.get(task.id);
    const b = store.tasks.get(task.id);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
    expect(a).not.toBe(task);
    expect(a!.id).toBe(task.id);
    expect(a!.title).toBe('greet');
    store.close();
  });

  it('returns detached graphs holding detached member tasks', () => {
    const store = new SqliteStore({ path: ':memory:' });
    const t1 = Task.bash('a');
    const g = new TaskGraph({ title: 'g' });
    g.add(t1);
    store.graphs.save(g);

    const g1 = store.graphs.get(g.id)!;
    const g2 = store.graphs.get(g.id)!;
    expect(g1).not.toBe(g2);
    expect(g1.tasks[0]).not.toBe(g2.tasks[0]);
    expect(g1.tasks[0]).not.toBe(t1);
    store.close();
  });
});

describe('SqliteStore — R-STORE-14 task roundtrip', () => {
  it('roundtrips every persisted field including TaskResult', () => {
    const store = new SqliteStore({ path: ':memory:' });
    const task = new Task(TaskType.BASH, 'echo hi', {
      title: 'greet',
      description: 'says hi',
      timeout: 30,
    });
    task.transitionTo(TaskStatus.RUNNING);
    task.transitionTo(TaskStatus.SUCCEEDED, { result: makeResultFor(task) });
    store.tasks.save(task);

    const reloaded = store.tasks.get(task.id)!;
    expect(reloaded.id).toBe(task.id);
    expect(reloaded.type).toBe(task.type);
    expect(reloaded.title).toBe(task.title);
    expect(reloaded.description).toBe(task.description);
    expect(reloaded.payload).toBe(task.payload);
    expect(reloaded.timeout).toBe(30);
    expect(reloaded.status).toBe(TaskStatus.SUCCEEDED);
    expect(reloaded.createdAt.toISOString()).toBe(task.createdAt.toISOString());

    const r = reloaded.result!;
    expect(r.taskId).toBe(task.id);
    expect(r.status).toBe(TaskStatus.SUCCEEDED);
    expect(r.duration).toBe(1.5);
    expect(r.output).toBe('hello\n');
    expect(r.returncode).toBe(0);
    expect(r.terminationReason).toBe('exit_code');
    expect(r.startedAt.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(r.finishedAt.toISOString()).toBe('2024-01-01T00:00:01.500Z');
    // R-STORE-14: raw MAY be dropped, SHOULD be null on reload.
    expect(r.raw).toBeNull();
    store.close();
  });

  it('roundtrips failed task error and blockedBy', () => {
    const store = new SqliteStore({ path: ':memory:' });
    const a = Task.bash('a');
    a.transitionTo(TaskStatus.RUNNING);
    a.transitionTo(TaskStatus.FAILED, { error: 'boom' });

    const b = Task.bash('b');
    b.transitionTo(TaskStatus.BLOCKED, { blockedBy: a.id });

    store.tasks.save(a);
    store.tasks.save(b);

    const ra = store.tasks.get(a.id)!;
    const rb = store.tasks.get(b.id)!;
    expect(ra.status).toBe(TaskStatus.FAILED);
    expect(ra.error).toBe('boom');
    expect(rb.status).toBe(TaskStatus.BLOCKED);
    expect(rb.blockedBy).toBe(a.id);
    store.close();
  });

  it('roundtrips each termination reason', () => {
    const store = new SqliteStore({ path: ':memory:' });
    const reasons: Array<'exit_code' | 'timeout' | 'cancelled' | 'handler'> = [
      'exit_code',
      'timeout',
      'cancelled',
      'handler',
    ];
    for (const reason of reasons) {
      const t = Task.bash(`x-${reason}`);
      t.transitionTo(TaskStatus.RUNNING);
      t.transitionTo(TaskStatus.SUCCEEDED, {
        result: new TaskResult({
          taskId: t.id,
          status: TaskStatus.SUCCEEDED,
          startedAt: new Date(),
          finishedAt: new Date(),
          duration: 0,
          output: '',
          error: null,
          raw: null,
          returncode: 0,
          terminationReason: reason,
        }),
      });
      store.tasks.save(t);
      expect(store.tasks.get(t.id)!.result!.terminationReason).toBe(reason);
    }
    store.close();
  });
});

describe('SqliteStore — R-STORE-15 graph roundtrip', () => {
  it('preserves membership, insertion order, edge order, finally/optional', () => {
    const store = new SqliteStore({ path: ':memory:' });
    const a = Task.bash('a');
    const b = Task.bash('b');
    const c = Task.bash('c');
    const d = Task.bash('d');
    const f = Task.bash('finally');

    const g = new TaskGraph({ title: 'topo' });
    g.add(a);
    g.add(b);
    g.add(c, { after: [a, b], finally_: true, required: false });
    g.add(d, { after: [a] });
    g.add(f, { finally_: true });
    store.graphs.save(g);

    const reloaded = store.graphs.get(g.id)!;
    expect(reloaded.id).toBe(g.id);
    expect(reloaded.title).toBe('topo');
    expect(reloaded.createdAt.toISOString()).toBe(g.createdAt.toISOString());

    const ids = reloaded.tasks.map((t) => t.id);
    expect(ids).toEqual([a.id, b.id, c.id, d.id, f.id]);

    const cReloaded = reloaded.tasks.find((t) => t.id === c.id)!;
    expect(reloaded.dependencies(cReloaded).map((t) => t.id)).toEqual([a.id, b.id]);
    expect(reloaded.isOptional(cReloaded)).toBe(true);
    expect(reloaded.isFinally(cReloaded)).toBe(true);

    const fReloaded = reloaded.tasks.find((t) => t.id === f.id)!;
    expect(reloaded.isFinally(fReloaded)).toBe(true);
    store.close();
  });
});

describe('SqliteStore — R-STORE-16 atomic graph save', () => {
  it('upserts graph + member tasks in one transaction', () => {
    const store = new SqliteStore({ path: ':memory:' });
    const a = Task.bash('a');
    const b = Task.bash('b');
    const g = new TaskGraph();
    g.add(a);
    g.add(b, { after: [a] });
    store.graphs.save(g);

    expect(store.tasks.has(a.id)).toBe(true);
    expect(store.tasks.has(b.id)).toBe(true);
    expect(store.graphs.has(g.id)).toBe(true);
    store.close();
  });
});

describe('SqliteStore — R-STORE-17 survives reopen', () => {
  it('persists tasks and graphs across store instances', () => {
    const path = newDbPath();
    const t = Task.bash('hello', { title: 'persist-me' });
    const g = new TaskGraph({ title: 'topology' });
    g.add(t);

    const s1 = new SqliteStore({ path });
    s1.graphs.save(g);
    s1.close();

    const s2 = new SqliteStore({ path });
    expect(s2.tasks.has(t.id)).toBe(true);
    expect(s2.graphs.has(g.id)).toBe(true);
    const reloaded = s2.graphs.get(g.id)!;
    expect(reloaded.tasks.map((x) => x.id)).toEqual([t.id]);
    expect(reloaded.tasks[0]!.title).toBe('persist-me');
    s2.close();
  });
});

describe('SqliteStore — R-STORE-18..21 schema management', () => {
  it('R-STORE-19: stamps schema_version on fresh empty database', () => {
    const path = newDbPath();
    const s = new SqliteStore({ path });
    s.close();
    // Reopen with no destructive flag: should succeed (version matches).
    const s2 = new SqliteStore({ path });
    s2.close();
  });

  it('R-STORE-20: refuses to open when known tables exist but version is missing', async () => {
    const path = newDbPath();
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(path);
    raw.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY)');
    raw.close();
    expect(() => new SqliteStore({ path })).toThrow(StoreSchemaMismatchError);
  });

  it('R-STORE-20: refuses on version mismatch without opt-in', async () => {
    const path = newDbPath();
    const s = new SqliteStore({ path });
    s.close();
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(path);
    raw.prepare('UPDATE meta SET value = ? WHERE key = ?').run('999', 'schema_version');
    raw.close();
    expect(() => new SqliteStore({ path })).toThrow(StoreSchemaMismatchError);
  });

  it('R-STORE-21: destructive migration drops/rebuilds and warns', async () => {
    const path = newDbPath();
    const s = new SqliteStore({ path });
    s.tasks.save(Task.bash('doomed'));
    s.close();
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(path);
    raw.prepare('UPDATE meta SET value = ? WHERE key = ?').run('999', 'schema_version');
    raw.close();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s2 = new SqliteStore({ path, allowDestructiveMigration: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(s2.tasks.size).toBe(0);
    s2.close();
  });
});

describe('SqliteStore — R-STORE-22 concurrent executor writes', () => {
  it('persists every task in a wide dag run with maxWorkers > 1', async () => {
    const store = new SqliteStore({ path: ':memory:' });
    const exec = new TaskExecutor({ store });
    exec.register(TaskType.BASH, createBashHandler());

    const root = Task.bash('echo root');
    const leaves: Task[] = [];
    const g = new TaskGraph({ title: 'wide' });
    g.add(root);
    for (let i = 0; i < 8; i++) {
      const t = Task.bash(`echo leaf-${i}`);
      leaves.push(t);
      g.add(t, { after: [root] });
    }
    await g.run(exec, { maxWorkers: 4 });

    expect(store.tasks.has(root.id)).toBe(true);
    for (const t of leaves) {
      expect(store.tasks.has(t.id)).toBe(true);
      expect(store.tasks.get(t.id)!.status).toBe(TaskStatus.SUCCEEDED);
    }
    store.close();
  });
});

describe('SqliteStore — R-STORE-24 graph run persistence', () => {
  it('persists the graph at start (before handlers) and at end', async () => {
    const store = new SqliteStore({ path: ':memory:' });
    const exec = new TaskExecutor({ store });
    exec.register(TaskType.BASH, createBashHandler());

    const t = Task.bash('echo hi');
    const g = new TaskGraph({ title: 'r24' });
    g.add(t);

    let observedAtStart = false;
    exec.events.subscribe((e) => {
      if (e.type === TaskEventType.STARTED) {
        observedAtStart = store.graphs.has(g.id);
      }
    });

    await g.run(exec);
    expect(observedAtStart).toBe(true);

    const finalGraph = store.graphs.get(g.id)!;
    expect(finalGraph.tasks[0]!.status).toBe(TaskStatus.SUCCEEDED);
    store.close();
  });

  it('does not persist an invalid graph', async () => {
    const store = new SqliteStore({ path: ':memory:' });
    const exec = new TaskExecutor({ store });

    // Build a cycle.
    const a = Task.bash('a');
    const b = Task.bash('b');
    const g = new TaskGraph();
    g.add(a);
    g.add(b, { after: [a] });
    // Manually create a cycle by adding a after b after the fact.
    g.add(a, { after: [b] });

    await expect(g.run(exec)).rejects.toBeInstanceOf(GraphValidationError);
    expect(store.graphs.has(g.id)).toBe(false);
    store.close();
  });
});
