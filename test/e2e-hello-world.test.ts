// End-to-end "hello world" smoke: real bash subprocesses + on-disk SQLite
// store + a small DAG, executed by TaskExecutor. Verifies the full stack
// from handler invocation through persistence and reload.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TaskExecutor } from '../src/executor.js';
import { TaskGraph } from '../src/graph.js';
import { createBashHandler } from '../src/handlers/bash.js';
import { SqliteStore } from '../src/store-sqlite.js';
import { Task, TaskStatus, TaskType } from '../src/task.js';

describe('e2e — hello world DAG with on-disk SQLite store', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ttasks-e2e-'));
    dbPath = join(dir, 'tasks.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs a diamond of real bash tasks, persists, and reloads', async () => {
    const store = new SqliteStore({ path: dbPath });
    try {
      const exec = new TaskExecutor({ store });
      exec.register(TaskType.BASH, createBashHandler());

      // Diamond:  hello -> world1 \
      //                          -> greet
      //                 \-> world2 /
      const hello = Task.bash('echo hello', { title: 'hello' });
      const world1 = Task.bash('echo world-one', { title: 'world1' });
      const world2 = Task.bash('echo world-two', { title: 'world2' });
      const greet = Task.bash('echo "hello world!"', { title: 'greet' });

      const g = new TaskGraph({ title: 'hello-world' });
      g.add(hello);
      g.add(world1, { after: [hello] });
      g.add(world2, { after: [hello] });
      g.add(greet, { after: [world1, world2] });

      await g.run(exec);

      expect(g.ok).toBe(true);
      for (const t of [hello, world1, world2, greet]) {
        expect(t.status).toBe(TaskStatus.SUCCEEDED);
      }

      const greetResult = greet.result!;
      expect(greetResult.returncode).toBe(0);
      expect(greetResult.output.trim()).toBe('hello world!');

      const helloResult = hello.result!;
      expect(helloResult.output.trim()).toBe('hello');

      expect(store.tasks.has(hello.id)).toBe(true);
      expect(store.tasks.has(greet.id)).toBe(true);
      expect(store.graphs.has(g.id)).toBe(true);
    } finally {
      store.close();
    }

    // Reopen the DB in a fresh process-shaped store and read everything back.
    const reopened = new SqliteStore({ path: dbPath });
    try {
      const loaded = reopened.graphs.get(/* set below */ (await firstGraphId(reopened)));
      expect(loaded).toBeDefined();
      const g2 = loaded as TaskGraph;
      expect(g2.title).toBe('hello-world');
      expect(g2.tasks).toHaveLength(4);

      const greet2 = g2.tasks.find((t) => t.title === 'greet');
      expect(greet2).toBeDefined();
      expect(greet2!.status).toBe(TaskStatus.SUCCEEDED);
      const out = greet2!.result!;
      expect(out.output.trim()).toBe('hello world!');

      // Dependency structure is preserved.
      const deps = g2.dependencies(greet2!);
      const depTitles = deps.map((d) => d.title).sort();
      expect(depTitles).toEqual(['world1', 'world2']);
    } finally {
      reopened.close();
    }
  });
});

async function firstGraphId(store: SqliteStore): Promise<string> {
  for (const id of store.graphs.ids()) {
    return id;
  }
  throw new Error('no graphs found in store');
}
