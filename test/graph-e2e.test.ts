import { describe, expect, it } from 'vitest';

import { TaskExecutor } from '../src/executor.js';
import { TaskGraph } from '../src/graph.js';
import { InMemoryStore } from '../src/store.js';
import { Task, TaskStatus, TaskType } from '../src/task.js';

describe('TaskGraph — scenarios S-GRAPH-01..10', () => {
  it('S-GRAPH-01: empty graph runs and reports ok', async () => {
    const exec = new TaskExecutor();
    const g = new TaskGraph();
    await g.run(exec);
    expect(g.ok).toBe(true);
  });

  it('S-GRAPH-02: single task end-to-end with store', async () => {
    const store = new InMemoryStore();
    const exec = new TaskExecutor({ store });
    exec.register(TaskType.BASH, () => 'done');
    const g = new TaskGraph();
    const t = Task.bash('x');
    g.add(t);
    await g.run(exec);
    expect(t.status).toBe(TaskStatus.SUCCEEDED);
    expect(store.tasks.has(t.id)).toBe(true);
    expect(store.graphs.has(g)).toBe(true);
  });

  it('S-GRAPH-03: linear chain A->B->C', async () => {
    const order: string[] = [];
    const exec = new TaskExecutor();
    exec.register(TaskType.BASH, (ctx) => {
      order.push(ctx.title);
      return ctx.title;
    });
    const g = new TaskGraph();
    const a = Task.bash('', { title: 'A' });
    const b = Task.bash('', { title: 'B' });
    const c = Task.bash('', { title: 'C' });
    g.add(a);
    g.add(b, { after: [a] });
    g.add(c, { after: [b] });
    await g.run(exec);
    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('S-GRAPH-04: diamond converges', async () => {
    const exec = new TaskExecutor();
    exec.register(TaskType.BASH, (ctx) => ctx.title);
    const g = new TaskGraph();
    const a = Task.bash('', { title: 'A' });
    const b = Task.bash('', { title: 'B' });
    const c = Task.bash('', { title: 'C' });
    const d = Task.bash('', { title: 'D' });
    g.add(a);
    g.add(b, { after: [a] });
    g.add(c, { after: [a] });
    g.add(d, { after: [b, c] });
    await g.run(exec);
    expect([a.status, b.status, c.status, d.status]).toEqual([
      TaskStatus.SUCCEEDED,
      TaskStatus.SUCCEEDED,
      TaskStatus.SUCCEEDED,
      TaskStatus.SUCCEEDED,
    ]);
  });

  it('S-GRAPH-05: failure cascades to descendants', async () => {
    const exec = new TaskExecutor();
    exec.register(TaskType.BASH, (ctx) => {
      if (ctx.title === 'A') throw new Error('boom');
      return ctx.title;
    });
    const g = new TaskGraph();
    const a = Task.bash('', { title: 'A' });
    const b = Task.bash('', { title: 'B' });
    const c = Task.bash('', { title: 'C' });
    g.add(a);
    g.add(b, { after: [a] });
    g.add(c, { after: [b] });
    await g.run(exec);
    expect(a.status).toBe(TaskStatus.FAILED);
    expect(b.status).toBe(TaskStatus.BLOCKED);
    expect(c.status).toBe(TaskStatus.BLOCKED);
    expect(g.ok).toBe(false);
  });

  it('S-GRAPH-06: optional finally cleanup runs even on failure', async () => {
    const exec = new TaskExecutor();
    let cleaned = false;
    exec.register(TaskType.BASH, (ctx) => {
      if (ctx.title === 'cleanup') {
        cleaned = true;
        return 'c';
      }
      throw new Error('boom');
    });
    const g = new TaskGraph();
    const a = Task.bash('', { title: 'A' });
    const cleanup = Task.bash('', { title: 'cleanup' });
    g.add(a);
    g.add(cleanup, { after: [a], finally_: true, required: false });
    await g.run(exec);
    expect(cleaned).toBe(true);
  });

  it('S-GRAPH-06 corrected: required failure -> ok=false even with optional cleanup', async () => {
    const exec = new TaskExecutor();
    exec.register(TaskType.BASH, (ctx) => {
      if (ctx.title === 'cleanup') return 'c';
      throw new Error('boom');
    });
    const g = new TaskGraph();
    const a = Task.bash('', { title: 'A' });
    const cleanup = Task.bash('', { title: 'cleanup' });
    g.add(a);
    g.add(cleanup, { after: [a], finally_: true, required: false });
    await g.run(exec);
    expect(g.ok).toBe(false);
    expect(g.optionalFailed).toEqual([]);
    expect(g.requiredFailed).toEqual([a]);
  });

  it('S-GRAPH-07: re-run skips already-succeeded tasks', async () => {
    const calls: string[] = [];
    const exec = new TaskExecutor();
    exec.register(TaskType.BASH, (ctx) => {
      calls.push(ctx.title);
      return ctx.title;
    });
    const g = new TaskGraph();
    const a = Task.bash('', { title: 'A' });
    const b = Task.bash('', { title: 'B' });
    g.add(a);
    g.add(b, { after: [a] });
    await g.run(exec);
    expect(calls).toEqual(['A', 'B']);
    calls.length = 0;
    await g.run(exec);
    expect(calls).toEqual([]);
  });

  it('S-GRAPH-08: bounded parallelism', async () => {
    let active = 0;
    let peak = 0;
    const exec = new TaskExecutor();
    exec.register(TaskType.BASH, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((r) => setTimeout(r, 10));
      active -= 1;
      return 'ok';
    });
    const g = new TaskGraph();
    const root = Task.bash('r');
    g.add(root);
    for (let i = 0; i < 5; i++) g.add(Task.bash(`l${i}`), { after: [root] });
    await g.run(exec, { maxWorkers: 3 });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('S-GRAPH-09: cycle detected', async () => {
    const exec = new TaskExecutor();
    exec.register(TaskType.BASH, () => 'ok');
    const g = new TaskGraph();
    const a = Task.bash('a');
    const b = Task.bash('b');
    g.add(a, { after: [b] });
    g.add(b, { after: [a] });
    await expect(g.run(exec)).rejects.toThrow();
  });

  it('S-GRAPH-10: independent branches isolated under failure', async () => {
    const exec = new TaskExecutor();
    exec.register(TaskType.BASH, (ctx) => {
      if (ctx.title === 'BAD') throw new Error('x');
      return 'ok';
    });
    const g = new TaskGraph();
    const bad = Task.bash('', { title: 'BAD' });
    const badChild = Task.bash('', { title: 'BC' });
    const good = Task.bash('', { title: 'GOOD' });
    const goodChild = Task.bash('', { title: 'GC' });
    g.add(bad);
    g.add(badChild, { after: [bad] });
    g.add(good);
    g.add(goodChild, { after: [good] });
    await g.run(exec);
    expect(bad.status).toBe(TaskStatus.FAILED);
    expect(badChild.status).toBe(TaskStatus.BLOCKED);
    expect(good.status).toBe(TaskStatus.SUCCEEDED);
    expect(goodChild.status).toBe(TaskStatus.SUCCEEDED);
  });
});
