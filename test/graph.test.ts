import { describe, expect, it } from 'vitest';

import {
  GraphCycleError,
  GraphValidationError,
  TaskGraph,
} from '../src/graph.js';
import { Task, TaskStatus } from '../src/task.js';

describe('TaskGraph — construction', () => {
  it('R-GRAPH-01: has a stable id assigned at construction', () => {
    const g1 = new TaskGraph();
    const g2 = new TaskGraph();
    expect(g1.id).not.toBe(g2.id);
    expect(g1.id.length).toBeGreaterThan(0);
  });

  it('R-GRAPH-02: title defaults to empty string', () => {
    expect(new TaskGraph().title).toBe('');
    expect(new TaskGraph({ title: 'pipeline' }).title).toBe('pipeline');
  });

  it('R-GRAPH-02: non-string titles rejected', () => {
    expect(() => new TaskGraph({ title: 42 as unknown as string })).toThrow(TypeError);
  });

  it('R-GRAPH-03: createdAt is set at construction', () => {
    const before = Date.now();
    const g = new TaskGraph();
    expect(g.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(g.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 5);
  });
});

describe('TaskGraph — add', () => {
  it('R-GRAPH-04: rejects non-Task and non-Task dependency', () => {
    const g = new TaskGraph();
    expect(() => g.add({} as Task)).toThrow(TypeError);
    expect(() => g.add(Task.bash('x'), { after: [{} as Task] })).toThrow(TypeError);
  });

  it('R-GRAPH-05: deduplicates dependencies (first appearance order)', () => {
    const g = new TaskGraph();
    const a = Task.bash('a');
    const b = Task.bash('b');
    const c = Task.bash('c');
    g.add(a);
    g.add(b);
    g.add(c, { after: [a, b, a] });
    expect(g.dependencies(c)).toEqual([a, b]);
  });

  it('R-GRAPH-06: validates finally_ and required flags', () => {
    const g = new TaskGraph();
    const t = Task.bash('x');
    expect(() => g.add(t, { finally_: 'no' as unknown as boolean })).toThrow(TypeError);
    expect(() => g.add(t, { required: 1 as unknown as boolean })).toThrow(TypeError);
    expect(() => g.add(t, { required: false })).toThrow(TypeError);
    g.add(t, { finally_: true, required: false });
    expect(g.isFinally(t)).toBe(true);
    expect(g.isOptional(t)).toBe(true);
  });

  it('R-GRAPH-06: re-add updates classification', () => {
    const g = new TaskGraph();
    const t = Task.bash('x');
    g.add(t);
    expect(g.isFinally(t)).toBe(false);
    g.add(t, { finally_: true });
    expect(g.isFinally(t)).toBe(true);
    expect(g.finallyTasks).toEqual([t]);
  });

  it('legacy positional API: add(task, [deps]) works', () => {
    const g = new TaskGraph();
    const a = Task.bash('a');
    const b = Task.bash('b');
    g.add(a);
    g.add(b, [a]);
    expect(g.dependencies(b)).toEqual([a]);
  });
});

describe('TaskGraph — topology', () => {
  it('R-GRAPH-08: dependencies returns direct upstream only', () => {
    const g = new TaskGraph();
    const a = Task.bash('a');
    const b = Task.bash('b');
    const c = Task.bash('c');
    g.add(a);
    g.add(b, { after: [a] });
    g.add(c, { after: [b] });
    expect(g.dependencies(c)).toEqual([b]);
  });

  it('R-GRAPH-09: roots and leaves in insertion order', () => {
    const g = new TaskGraph();
    const a = Task.bash('a');
    const b = Task.bash('b');
    const c = Task.bash('c');
    const d = Task.bash('d');
    g.add(a);
    g.add(b);
    g.add(c, { after: [a, b] });
    g.add(d, { after: [a] });
    expect(g.roots()).toEqual([a, b]);
    expect(g.leaves()).toEqual([c, d]);
  });

  it('R-GRAPH-09: empty graph yields empty roots/leaves', () => {
    const g = new TaskGraph();
    expect(g.roots()).toEqual([]);
    expect(g.leaves()).toEqual([]);
  });
});
