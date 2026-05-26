import { describe, expect, it } from 'vitest';

import { TaskEventType, type TaskEvent } from '../src/events.js';
import { TaskExecutor, type TaskContext } from '../src/executor.js';
import {
  GraphCycleError,
  GraphNoProgressError,
  GraphValidationError,
  TaskGraph,
} from '../src/graph.js';
import { InMemoryStore } from '../src/store.js';
import { Task, TaskStatus, TaskType } from '../src/task.js';

function bashExec(handler: (ctx: TaskContext) => unknown | Promise<unknown> = () => 'ok'): TaskExecutor {
  const exec = new TaskExecutor();
  exec.register(TaskType.BASH, handler);
  return exec;
}

describe('TaskGraph.run — validation', () => {
  it('R-GRAPH-10: rejects maxWorkers <= 0', async () => {
    const g = new TaskGraph();
    await expect(g.run(bashExec(), { maxWorkers: 0 })).rejects.toBeInstanceOf(
      GraphValidationError,
    );
    await expect(g.run(bashExec(), { maxWorkers: -3 })).rejects.toBeInstanceOf(
      GraphValidationError,
    );
  });

  it('R-GRAPH-11: rejects unregistered dependencies', async () => {
    const g = new TaskGraph();
    const a = Task.bash('a');
    const b = Task.bash('b');
    g.add(b, { after: [a] }); // a not added
    await expect(g.run(bashExec())).rejects.toBeInstanceOf(GraphValidationError);
  });

  it('R-GRAPH-12: rejects self-loop', async () => {
    const g = new TaskGraph();
    const a = Task.bash('a');
    g.add(a, { after: [a] });
    await expect(g.run(bashExec())).rejects.toBeInstanceOf(GraphCycleError);
  });

  it('R-GRAPH-12: rejects two-node cycle', async () => {
    const g = new TaskGraph();
    const a = Task.bash('a');
    const b = Task.bash('b');
    g.add(a, { after: [b] });
    g.add(b, { after: [a] });
    await expect(g.run(bashExec())).rejects.toBeInstanceOf(GraphCycleError);
  });

  it('R-GRAPH-13: rejects stale RUNNING tasks', async () => {
    const g = new TaskGraph();
    const a = Task.bash('a');
    a.transitionTo(TaskStatus.RUNNING);
    g.add(a);
    await expect(g.run(bashExec())).rejects.toBeInstanceOf(GraphValidationError);
  });
});

describe('TaskGraph.run — scheduling', () => {
  it('R-GRAPH-14, R-GRAPH-29: linear chain runs in order; returns self', async () => {
    const exec = bashExec();
    const events: TaskEvent[] = [];
    exec.events.subscribe((e) => events.push(e));
    const g = new TaskGraph();
    const a = Task.bash('a', { title: 'A' });
    const b = Task.bash('b', { title: 'B' });
    const c = Task.bash('c', { title: 'C' });
    g.add(a);
    g.add(b, { after: [a] });
    g.add(c, { after: [b] });
    const ret = await g.run(exec);
    expect(ret).toBe(g);
    expect([a.status, b.status, c.status]).toEqual([
      TaskStatus.SUCCEEDED,
      TaskStatus.SUCCEEDED,
      TaskStatus.SUCCEEDED,
    ]);
    const succeededIds = events
      .filter((e) => e.type === TaskEventType.SUCCEEDED)
      .map((e) => e.taskId);
    expect(succeededIds).toEqual([a.id, b.id, c.id]);
    expect(g.ok).toBe(true);
  });

  it('R-GRAPH-16, R-GRAPH-27: failure blocks descendants; ok=false', async () => {
    const exec = new TaskExecutor();
    exec.register(TaskType.BASH, (ctx) => {
      if (ctx.title === 'A') throw new Error('A boom');
      return 'ok';
    });
    const g = new TaskGraph();
    const a = Task.bash('a', { title: 'A' });
    const b = Task.bash('b', { title: 'B' });
    const c = Task.bash('c', { title: 'C' });
    g.add(a);
    g.add(b, { after: [a] });
    g.add(c, { after: [b] });
    await g.run(exec);
    expect(a.status).toBe(TaskStatus.FAILED);
    expect(b.status).toBe(TaskStatus.BLOCKED);
    expect(b.blockedBy).toBe(a.id);
    expect(c.status).toBe(TaskStatus.BLOCKED);
    expect(c.blockedBy).toBe(b.id);
    expect(g.ok).toBe(false);
    expect(g.errors.get(a.id)?.message).toBe('A boom');
  });

  it('R-GRAPH-18: independent branches are unaffected', async () => {
    const exec = new TaskExecutor();
    exec.register(TaskType.BASH, (ctx) => {
      if (ctx.title === 'A') throw new Error('boom');
      return 'ok';
    });
    const g = new TaskGraph();
    const a = Task.bash('', { title: 'A' });
    const b = Task.bash('', { title: 'B' });
    const x = Task.bash('', { title: 'X' });
    const y = Task.bash('', { title: 'Y' });
    g.add(a);
    g.add(b, { after: [a] });
    g.add(x);
    g.add(y, { after: [x] });
    await g.run(exec);
    expect(a.status).toBe(TaskStatus.FAILED);
    expect(b.status).toBe(TaskStatus.BLOCKED);
    expect(x.status).toBe(TaskStatus.SUCCEEDED);
    expect(y.status).toBe(TaskStatus.SUCCEEDED);
  });

  it('R-GRAPH-15, R-GRAPH-17: finally runs after failed and blocked parents', async () => {
    const exec = new TaskExecutor();
    let cleanupRan = false;
    exec.register(TaskType.BASH, (ctx) => {
      if (ctx.title === 'A') throw new Error('boom');
      if (ctx.title === 'cleanup') {
        cleanupRan = true;
        return 'cleaned';
      }
      return 'ok';
    });
    const g = new TaskGraph();
    const a = Task.bash('', { title: 'A' });
    const b = Task.bash('', { title: 'B' });
    const cleanup = Task.bash('', { title: 'cleanup' });
    g.add(a);
    g.add(b, { after: [a] });
    g.add(cleanup, { after: [a, b], finally_: true });
    await g.run(exec);
    expect(a.status).toBe(TaskStatus.FAILED);
    expect(b.status).toBe(TaskStatus.BLOCKED);
    expect(cleanup.status).toBe(TaskStatus.SUCCEEDED);
    expect(cleanupRan).toBe(true);
  });

  it('R-GRAPH-19: GraphNoProgressError is exported as a defensive guard', () => {
    // The no-progress guard is unreachable under normal scheduling because
    // every PENDING task either has a bad parent (-> markBlocked), or all
    // parents satisfied (-> launched), or it's a carryover-BLOCKED task with
    // a satisfiable parent (-> launched). Verify the error class exists for
    // defensive use.
    expect(typeof GraphNoProgressError).toBe('function');
    const err = new GraphNoProgressError('stuck');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('GraphNoProgressError');
  });

  it('R-GRAPH-20: parallelism is bounded by maxWorkers', async () => {
    let active = 0;
    let peak = 0;
    const exec = new TaskExecutor();
    exec.register(TaskType.BASH, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((r) => setTimeout(r, 20));
      active -= 1;
      return 'ok';
    });
    const g = new TaskGraph();
    const root = Task.bash('root');
    g.add(root);
    const leaves: Task[] = [];
    for (let i = 0; i < 6; i++) {
      const t = Task.bash(`leaf-${i}`);
      g.add(t, { after: [root] });
      leaves.push(t);
    }
    await g.run(exec, { maxWorkers: 2 });
    expect(peak).toBeLessThanOrEqual(2);
    expect(leaves.every((t) => t.status === TaskStatus.SUCCEEDED)).toBe(true);
  });
});

describe('TaskGraph.run — retry/re-run', () => {
  it('R-GRAPH-21: already-SUCCEEDED tasks are not re-executed', async () => {
    let calls = 0;
    const exec = new TaskExecutor();
    exec.register(TaskType.BASH, (ctx) => {
      calls += 1;
      return ctx.title;
    });
    const g = new TaskGraph();
    const a = Task.bash('', { title: 'A' });
    const b = Task.bash('', { title: 'B' });
    g.add(a);
    g.add(b, { after: [a] });
    await g.run(exec);
    expect(calls).toBe(2);
    await g.run(exec);
    expect(calls).toBe(2);
    expect(g.ok).toBe(true);
  });

  it('R-GRAPH-22: carryover-blocked task recovers when parent succeeds', async () => {
    const exec = bashExec();
    const g = new TaskGraph();
    const parent = Task.bash('p');
    const child = Task.bash('c');
    g.add(parent);
    g.add(child, { after: [parent] });
    // Pre-block child as if from a prior run.
    child.transitionTo(TaskStatus.BLOCKED, { blockedBy: parent.id });
    await g.run(exec);
    expect(parent.status).toBe(TaskStatus.SUCCEEDED);
    expect(child.status).toBe(TaskStatus.SUCCEEDED);
  });

  it('R-GRAPH-23: errors map resets at start of run', async () => {
    const exec = new TaskExecutor();
    let fail = true;
    exec.register(TaskType.BASH, () => {
      if (fail) throw new Error('first');
      return 'ok';
    });
    const g = new TaskGraph();
    const a = Task.bash('a');
    g.add(a);
    await g.run(exec);
    expect(g.errors.size).toBe(1);
    fail = false;
    // Manually re-enable a (FAILED -> RUNNING is allowed).
    a.transitionTo(TaskStatus.RUNNING);
    a.transitionTo(TaskStatus.FAILED, { error: 'reset for test' });
    await g.run(exec);
    expect(g.errors.size).toBe(0);
    expect(a.status).toBe(TaskStatus.SUCCEEDED);
  });
});

describe('TaskGraph.run — upstream context', () => {
  it('R-GRAPH-24: handler sees only direct upstream parents', async () => {
    const exec = new TaskExecutor();
    const seen = new Map<string, string[]>();
    exec.register(TaskType.BASH, (ctx) => {
      seen.set(ctx.title, [...ctx.upstream.keys()]);
      return 'ok';
    });
    const g = new TaskGraph();
    const a = Task.bash('', { title: 'A' });
    const b = Task.bash('', { title: 'B' });
    const c = Task.bash('', { title: 'C' });
    g.add(a);
    g.add(b, { after: [a] });
    g.add(c, { after: [b] });
    await g.run(exec);
    expect(seen.get('A')).toEqual([]);
    expect(seen.get('B')).toEqual([a.id]);
    expect(seen.get('C')).toEqual([b.id]);
  });
});

describe('TaskGraph — ok and optional', () => {
  it('R-GRAPH-27: empty graph reports ok=true', async () => {
    const g = new TaskGraph();
    await g.run(bashExec());
    expect(g.ok).toBe(true);
  });

  it('R-GRAPH-27: un-run graph reports ok=false', () => {
    const g = new TaskGraph();
    g.add(Task.bash('x'));
    expect(g.ok).toBe(false);
  });

  it('R-GRAPH-27: optional finally failure does not break ok', async () => {
    const exec = new TaskExecutor();
    exec.register(TaskType.BASH, (ctx) => {
      if (ctx.title === 'opt') throw new Error('optional boom');
      return 'ok';
    });
    const g = new TaskGraph();
    const a = Task.bash('', { title: 'A' });
    const opt = Task.bash('', { title: 'opt' });
    g.add(a);
    g.add(opt, { after: [a], finally_: true, required: false });
    await g.run(exec);
    expect(g.ok).toBe(true);
    expect(g.optionalFailed).toEqual([opt]);
    expect(g.requiredFailed).toEqual([]);
  });

  it('R-GRAPH-27: required finally failure breaks ok', async () => {
    const exec = new TaskExecutor();
    exec.register(TaskType.BASH, (ctx) => {
      if (ctx.title === 'req') throw new Error('boom');
      return 'ok';
    });
    const g = new TaskGraph();
    const a = Task.bash('', { title: 'A' });
    const req = Task.bash('', { title: 'req' });
    g.add(a);
    g.add(req, { after: [a], finally_: true });
    await g.run(exec);
    expect(g.ok).toBe(false);
  });

  it('R-GRAPH-30: empty graph runs without hanging', async () => {
    const g = new TaskGraph();
    const ret = await g.run(bashExec());
    expect(ret).toBe(g);
  });
});

describe('TaskGraph.run — persistence (R-GRAPH-28 / R-STORE-24)', () => {
  it('persists graph at start and end of run', async () => {
    const store = new InMemoryStore();
    const exec = new TaskExecutor({ store });
    exec.register(TaskType.BASH, () => 'ok');
    const g = new TaskGraph();
    const a = Task.bash('a');
    g.add(a);
    expect(store.graphs.has(g)).toBe(false);
    await g.run(exec);
    expect(store.graphs.has(g)).toBe(true);
    expect(exec.graphPersistenceErrors).toEqual([]);
  });

  it('captures graph save errors without propagating', async () => {
    const failingStore = {
      tasks: {
        save: () => undefined,
        get: () => undefined,
        has: () => false,
        delete: () => undefined,
      },
      graphs: {
        save: () => {
          throw new Error('graph disk full');
        },
        get: () => undefined,
        has: () => false,
        delete: () => undefined,
      },
    };
    const exec = new TaskExecutor({ store: failingStore as never });
    exec.register(TaskType.BASH, () => 'ok');
    const g = new TaskGraph();
    g.add(Task.bash('x'));
    await g.run(exec);
    expect(exec.graphPersistenceErrors.length).toBe(2);
    expect(exec.graphPersistenceErrors[0]?.graphId).toBe(g.id);
  });
});
