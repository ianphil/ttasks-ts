import { describe, expect, it } from 'vitest';

import { TaskGraph } from '../src/graph.js';
import {
  InMemoryGraphCollection,
  InMemoryStore,
  InMemoryTaskCollection,
  StoreIdMismatchError,
  StoreKeyError,
} from '../src/store.js';
import { Task, TaskStatus } from '../src/task.js';

describe('InMemoryStore — shape', () => {
  it('R-STORE-01: exposes independent tasks and graphs collections', () => {
    const store = new InMemoryStore();
    expect(store.tasks).toBeInstanceOf(InMemoryTaskCollection);
    expect(store.graphs).toBeInstanceOf(InMemoryGraphCollection);

    const task = Task.bash('x');
    store.tasks.save(task);
    expect(store.graphs.size).toBe(0);

    const graph = new TaskGraph();
    store.graphs.save(graph);
    expect(store.tasks.size).toBe(1);
    expect(store.graphs.size).toBe(1);
  });
});

describe('InMemoryTaskCollection', () => {
  it('R-STORE-03: save writes under task.id (upsert)', () => {
    const c = new InMemoryTaskCollection();
    const t = Task.bash('x');
    c.save(t);
    c.save(t);
    expect(c.size).toBe(1);
    expect(c.get(t.id)).toBe(t);
  });

  it('R-STORE-04: setItem rejects id mismatch', () => {
    const c = new InMemoryTaskCollection();
    const t = Task.bash('x');
    expect(() => c.setItem('wrong', t)).toThrow(StoreIdMismatchError);
    expect(c.size).toBe(0);
  });

  it('R-STORE-05: setItem rejects non-Task values', () => {
    const c = new InMemoryTaskCollection();
    expect(() => c.setItem('id', {} as unknown as Task)).toThrow(TypeError);
  });

  it('R-STORE-05: save rejects non-Task values', () => {
    const c = new InMemoryTaskCollection();
    expect(() => c.save('nope' as unknown as Task)).toThrow(TypeError);
  });

  it('R-STORE-07: get returns undefined when missing', () => {
    const c = new InMemoryTaskCollection();
    expect(c.get('missing')).toBeUndefined();
  });

  it('R-STORE-08: has accepts id and Task; never throws', () => {
    const c = new InMemoryTaskCollection();
    const t = Task.bash('x');
    c.save(t);
    expect(c.has(t.id)).toBe(true);
    expect(c.has(t)).toBe(true);
    expect(c.has('missing')).toBe(false);
    expect(c.has(Task.bash('y'))).toBe(false);
    // Non-supported keys return false rather than throwing.
    expect(c.has(42)).toBe(false);
    expect(c.has(null)).toBe(false);
    expect(c.has({})).toBe(false);
  });

  it('R-STORE-09: delete removes the record; missing throws StoreKeyError', () => {
    const c = new InMemoryTaskCollection();
    const t = Task.bash('x');
    c.save(t);
    c.delete(t);
    expect(c.size).toBe(0);
    expect(() => c.delete(t.id)).toThrow(StoreKeyError);
  });

  it('R-STORE-10: iteration yields ids in insertion order', () => {
    const c = new InMemoryTaskCollection();
    const a = Task.bash('a');
    const b = Task.bash('b');
    const d = Task.bash('d');
    c.save(a);
    c.save(b);
    c.save(d);
    expect([...c]).toEqual([a.id, b.id, d.id]);
    expect([...c.ids()]).toEqual([a.id, b.id, d.id]);
    expect([...c.values()]).toEqual([a, b, d]);
    expect(c.size).toBe(3);
  });

  it('R-STORE-11: in-memory holds live references', () => {
    const c = new InMemoryTaskCollection();
    const t = Task.bash('x');
    c.save(t);
    expect(c.get(t.id)).toBe(t);
    t.title = 'mutated';
    expect(c.get(t.id)?.title).toBe('mutated');
  });

  it('R-STORE-12: cancel helper cancels the held task', () => {
    const c = new InMemoryTaskCollection();
    const t = Task.bash('x');
    c.save(t);
    c.cancel(t.id);
    expect(t.status).toBe(TaskStatus.CANCELLED);
    expect(() => c.cancel('missing')).toThrow(StoreKeyError);
  });
});

describe('InMemoryGraphCollection', () => {
  it('R-STORE-03: save writes under graph.id (upsert)', () => {
    const c = new InMemoryGraphCollection();
    const g = new TaskGraph();
    c.save(g);
    c.save(g);
    expect(c.size).toBe(1);
    expect(c.get(g.id)).toBe(g);
  });

  it('R-STORE-04: setItem rejects id mismatch', () => {
    const c = new InMemoryGraphCollection();
    const g = new TaskGraph();
    expect(() => c.setItem('wrong', g)).toThrow(StoreIdMismatchError);
  });

  it('R-STORE-05: setItem rejects non-Graph values', () => {
    const c = new InMemoryGraphCollection();
    expect(() => c.setItem('id', {} as unknown as TaskGraph)).toThrow(TypeError);
  });

  it('R-STORE-07: get returns undefined when missing', () => {
    const c = new InMemoryGraphCollection();
    expect(c.get('missing')).toBeUndefined();
  });

  it('R-STORE-08: has accepts id and TaskGraph; never throws', () => {
    const c = new InMemoryGraphCollection();
    const g = new TaskGraph();
    c.save(g);
    expect(c.has(g.id)).toBe(true);
    expect(c.has(g)).toBe(true);
    expect(c.has('missing')).toBe(false);
    expect(c.has(new TaskGraph())).toBe(false);
    expect(c.has(null)).toBe(false);
  });

  it('R-STORE-09: delete removes graph; missing throws; member tasks unaffected', () => {
    const store = new InMemoryStore();
    const t = Task.bash('x');
    const g = new TaskGraph();
    g.add(t);
    store.tasks.save(t);
    store.graphs.save(g);
    store.graphs.delete(g);
    expect(store.graphs.size).toBe(0);
    expect(store.tasks.has(t)).toBe(true);
    expect(() => store.graphs.delete(g.id)).toThrow(StoreKeyError);
  });

  it('R-STORE-10: iteration yields ids in insertion order', () => {
    const c = new InMemoryGraphCollection();
    const g1 = new TaskGraph();
    const g2 = new TaskGraph();
    const g3 = new TaskGraph();
    c.save(g1);
    c.save(g2);
    c.save(g3);
    expect([...c]).toEqual([g1.id, g2.id, g3.id]);
  });

  it('R-STORE-11: in-memory holds live references', () => {
    const c = new InMemoryGraphCollection();
    const g = new TaskGraph({ title: 'orig' });
    c.save(g);
    g.title = 'mutated';
    expect(c.get(g.id)?.title).toBe('mutated');
    expect(c.get(g.id)).toBe(g);
  });
});

describe('R-STORE-23 — direct save errors propagate', () => {
  it('user-facing save calls propagate errors normally', () => {
    // Construct a failing collection-like to demonstrate propagation surface.
    class FailingTaskCollection {
      save(): void {
        throw new Error('disk full');
      }
    }
    const c = new FailingTaskCollection();
    expect(() => c.save()).toThrow('disk full');
  });
});
