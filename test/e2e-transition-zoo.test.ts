// End-to-end "transition zoo": one graph that exercises every executor
// state path (SUCCEEDED / FAILED via exit code / FAILED via timeout /
// BLOCKED / chained BLOCKED / optional-finally FAILED / required-finally
// SUCCEEDED / finally with no upstream / finally on blocked+failed deps),
// plus a persistence sibling that re-opens the SQLite store and asserts
// statuses and results round-trip.
//
// Ported from ttasks (Python) tests/test_e2e.py::test_transition_zoo*.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TaskEventType, type TaskEvent } from '../src/events.js';
import { TaskExecutor } from '../src/executor.js';
import { TaskGraph } from '../src/graph.js';
import { createBashHandler } from '../src/handlers/bash.js';
import { SqliteStore } from '../src/store-sqlite.js';
import { Task, TaskStatus, TaskType } from '../src/task.js';

type Labels =
  | 'R1' | 'R2' | 'R3'
  | 'A' | 'B' | 'C' | 'D' | 'E'
  | 'H' | 'I' | 'J' | 'K' | 'L' | 'M'
  | 'P' | 'Q' | 'S'
  | 'F1' | 'F2' | 'F3' | 'F4' | 'F5';

const EXPECTED_ZOO_STATUS: Record<Labels, TaskStatus> = {
  R1: TaskStatus.SUCCEEDED, R2: TaskStatus.SUCCEEDED, R3: TaskStatus.SUCCEEDED,
  A: TaskStatus.SUCCEEDED, B: TaskStatus.FAILED, C: TaskStatus.SUCCEEDED,
  D: TaskStatus.SUCCEEDED, E: TaskStatus.SUCCEEDED,
  H: TaskStatus.SUCCEEDED, I: TaskStatus.SUCCEEDED,
  J: TaskStatus.BLOCKED,   // blocked by B
  K: TaskStatus.SUCCEEDED,
  L: TaskStatus.FAILED,    // timeout
  M: TaskStatus.SUCCEEDED,
  P: TaskStatus.SUCCEEDED,
  Q: TaskStatus.BLOCKED,   // blocked transitively via J
  S: TaskStatus.BLOCKED,   // blocked transitively via L
  F1: TaskStatus.SUCCEEDED,
  F2: TaskStatus.FAILED,   // optional finally that itself fails
  F3: TaskStatus.SUCCEEDED, // chained finally-on-finally
  F4: TaskStatus.SUCCEEDED, // finally with no upstream
  F5: TaskStatus.SUCCEEDED, // finally on blocked + failed deps still runs
};

const EXPECTED_BLOCKED_LABELS: Labels[] = ['J', 'Q', 'S'];

const TERMINAL_TYPES = new Set<TaskEventType>([
  TaskEventType.SUCCEEDED,
  TaskEventType.FAILED,
  TaskEventType.CANCELLED,
  TaskEventType.BLOCKED,
]);

function buildTransitionZoo(): { g: TaskGraph; t: Record<Labels, Task> } {
  const t = {} as Record<Labels, Task>;

  for (const name of ['R1', 'R2', 'R3'] as const) {
    t[name] = Task.bash('true', { title: name });
  }

  t.A = Task.bash('true',   { title: 'A' });
  t.B = Task.bash('exit 1', { title: 'B' });                        // exit-code FAILED
  t.C = Task.bash('true',   { title: 'C' });
  t.D = Task.bash('true',   { title: 'D' });
  t.E = Task.bash('true',   { title: 'E' });

  t.H = Task.bash('true',    { title: 'H' });
  t.I = Task.bash('true',    { title: 'I' });
  t.J = Task.bash('true',    { title: 'J' });                       // blocked by B
  t.K = Task.bash('true',    { title: 'K' });
  t.L = Task.bash('sleep 5', { title: 'L', timeout: 0.1 });         // timeout FAILED
  t.M = Task.bash('true',    { title: 'M' });

  t.P = Task.bash('true', { title: 'P' });
  t.Q = Task.bash('true', { title: 'Q' });                          // blocked transitively (B -> J -> Q)
  t.S = Task.bash('true', { title: 'S' });                          // blocked transitively via L (timeout)

  t.F1 = Task.bash('true',   { title: 'F1' });
  t.F2 = Task.bash('exit 1', { title: 'F2' });                      // optional finally that fails
  t.F3 = Task.bash('true',   { title: 'F3' });
  t.F4 = Task.bash('true',   { title: 'F4' });
  t.F5 = Task.bash('true',   { title: 'F5' });

  const g = new TaskGraph({ title: 'transition-zoo' });

  g.add(t.R1);
  g.add(t.R2);
  g.add(t.R3);

  g.add(t.A, { after: [t.R1] });
  g.add(t.B, { after: [t.R1, t.R2] });
  g.add(t.C, { after: [t.R2] });
  g.add(t.D, { after: [t.R2, t.R3] });
  g.add(t.E, { after: [t.R3] });

  g.add(t.H, { after: [t.A] });
  g.add(t.I, { after: [t.C] });
  g.add(t.J, { after: [t.A, t.B] });          // multi-parent, B FAILED -> BLOCKED
  g.add(t.K, { after: [t.D] });
  g.add(t.L, { after: [t.D, t.E] });          // will FAIL via timeout
  g.add(t.M, { after: [t.E] });

  g.add(t.P, { after: [t.H, t.K] });          // both parents succeed
  g.add(t.Q, { after: [t.J] });               // parent BLOCKED -> BLOCKED
  g.add(t.S, { after: [t.L] });               // parent FAILED (timeout) -> BLOCKED

  g.add(t.F1, { after: [t.P],        finally_: true, required: true });
  g.add(t.F2, { after: [t.Q],        finally_: true, required: false });
  g.add(t.F3, { after: [t.F1],       finally_: true, required: true });
  g.add(t.F4, { after: [],           finally_: true, required: true });
  g.add(t.F5, { after: [t.S, t.L],   finally_: true, required: false });

  return { g, t };
}

function makeExecutor(events: TaskEvent[], store?: SqliteStore): TaskExecutor {
  const exec = store ? new TaskExecutor({ store }) : new TaskExecutor();
  exec.register(TaskType.BASH, createBashHandler());
  exec.events.subscribe((ev) => events.push(ev));
  return exec;
}

function terminalsByTask(events: Iterable<TaskEvent>): Map<string, TaskEvent> {
  const out = new Map<string, TaskEvent>();
  for (const ev of events) {
    if (!TERMINAL_TYPES.has(ev.type)) continue;
    if (out.has(ev.taskId)) {
      throw new Error(
        `task ${ev.taskId} got two terminal events: ${out.get(ev.taskId)!.type} and ${ev.type}`,
      );
    }
    out.set(ev.taskId, ev);
  }
  return out;
}

describe('e2e — transition zoo', () => {
  it('exercises every executor state path with literal assertions', async () => {
    const { g, t } = buildTransitionZoo();
    const events: TaskEvent[] = [];
    const exec = makeExecutor(events);

    await g.run(exec);

    // 1. Exact per-task status.
    const actualStatus = Object.fromEntries(
      (Object.keys(EXPECTED_ZOO_STATUS) as Labels[]).map((l) => [l, t[l].status]),
    );
    expect(actualStatus).toEqual(EXPECTED_ZOO_STATUS);

    // 2. graph.ok is false (B and L are required failures; F2 is optional).
    expect(g.ok).toBe(false);

    // 3. Exact node identity for the three buckets.
    const expectedDoneIds = new Set(
      (Object.entries(EXPECTED_ZOO_STATUS) as [Labels, TaskStatus][])
        .filter(([, s]) => s === TaskStatus.SUCCEEDED)
        .map(([l]) => t[l].id),
    );
    const expectedFailedIds = new Set(
      (Object.entries(EXPECTED_ZOO_STATUS) as [Labels, TaskStatus][])
        .filter(([, s]) => s === TaskStatus.FAILED)
        .map(([l]) => t[l].id),
    );
    const expectedBlockedIds = new Set(EXPECTED_BLOCKED_LABELS.map((l) => t[l].id));

    expect(new Set(g.succeeded.map((tk) => tk.id))).toEqual(expectedDoneIds);
    expect(new Set(g.failed.map((tk) => tk.id))).toEqual(expectedFailedIds);
    expect(new Set(g.blocked.map((tk) => tk.id))).toEqual(expectedBlockedIds);

    expect(g.optionalFailed.map((tk) => tk.id)).toEqual([t.F2.id]);
    expect(new Set(g.requiredFailed.map((tk) => tk.id))).toEqual(
      new Set([t.B.id, t.L.id]),
    );
    expect(new Set(g.requiredBlocked.map((tk) => tk.id))).toEqual(
      new Set([t.J.id, t.Q.id, t.S.id]),
    );

    // 4. Blocked tasks never STARTED and have no result.
    const startedIds = new Set(
      events.filter((ev) => ev.type === TaskEventType.STARTED).map((ev) => ev.taskId),
    );
    for (const label of EXPECTED_BLOCKED_LABELS) {
      expect(startedIds.has(t[label].id)).toBe(false);
      expect(t[label].result).toBeNull();
    }

    // 5. Every task got exactly one terminal event (including BLOCKED).
    const terminals = terminalsByTask(events);
    expect(new Set(terminals.keys())).toEqual(
      new Set((Object.keys(EXPECTED_ZOO_STATUS) as Labels[]).map((l) => t[l].id)),
    );

    // 5b. BLOCKED tasks record the upstream parent that blocked them.
    expect(t.J.blockedBy).toBe(t.B.id);
    expect(t.Q.blockedBy).toBe(t.J.id);
    expect(t.S.blockedBy).toBe(t.L.id);

    // 6. Event ordering: for every dep edge u -> v where both terminated and
    //    v is not BLOCKED, u's terminal event precedes v's. BLOCKED is emitted
    //    as soon as one parent fails, so its other parents may legitimately
    //    terminate later.
    for (const v of g) {
      const tv = terminals.get(v.id);
      if (!tv) continue;
      if (v.status === TaskStatus.BLOCKED) continue;
      for (const u of g.dependencies(v)) {
        const tu = terminals.get(u.id);
        if (!tu) continue;
        expect(tu.timestamp.getTime()).toBeLessThanOrEqual(tv.timestamp.getTime());
      }
    }

    // 7. terminationReason distinguishes B (non-zero exit) from L (timeout).
    expect(t.B.result).not.toBeNull();
    expect(t.B.result!.terminationReason).toBe('exit_code');
    expect(t.L.result).not.toBeNull();
    expect(t.L.result!.terminationReason).toBe('timeout');
    // SUCCEEDED tasks carry no terminationReason.
    expect(t.A.result).not.toBeNull();
    expect(t.A.result!.terminationReason).toBeNull();
  });
});

describe('e2e — transition zoo persistence', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ttasks-zoo-'));
    dbPath = join(dir, 'zoo.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists every task; statuses and results survive a reopen', async () => {
    const store = new SqliteStore({ path: dbPath });
    const { g, t } = buildTransitionZoo();
    const events: TaskEvent[] = [];
    try {
      const exec = makeExecutor(events, store);
      store.graphs.save(g);
      await g.run(exec);
    } finally {
      store.close();
    }

    const reopened = new SqliteStore({ path: dbPath });
    try {
      const persistedGraph = reopened.graphs.get(g.id);
      expect(persistedGraph).toBeDefined();
      expect(new Set(persistedGraph!.tasks.map((tk) => tk.id))).toEqual(
        new Set(g.tasks.map((tk) => tk.id)),
      );

      for (const label of Object.keys(EXPECTED_ZOO_STATUS) as Labels[]) {
        const task = t[label];
        const persisted = reopened.tasks.get(task.id);
        expect(persisted, `${label} missing from store`).toBeDefined();
        expect(persisted!.status, `${label} status differs`).toBe(
          EXPECTED_ZOO_STATUS[label],
        );

        // Result presence parity (blocked tasks have no result).
        expect(
          persisted!.result === null,
          `${label} result-presence differs`,
        ).toBe(task.result === null);

        if (task.result !== null && persisted!.result !== null) {
          expect(persisted!.result.output).toBe(task.result.output);
          expect(persisted!.result.error).toBe(task.result.error);
          expect(persisted!.result.terminationReason).toBe(
            task.result.terminationReason,
          );
        }
      }

      // blockedBy survives the round-trip too.
      const persistedJ = reopened.tasks.get(t.J.id)!;
      const persistedQ = reopened.tasks.get(t.Q.id)!;
      const persistedS = reopened.tasks.get(t.S.id)!;
      expect(persistedJ.blockedBy).toBe(t.B.id);
      expect(persistedQ.blockedBy).toBe(t.J.id);
      expect(persistedS.blockedBy).toBe(t.L.id);
    } finally {
      reopened.close();
    }
  });
});
