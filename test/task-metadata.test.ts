import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InMemoryStore } from '../src/store.js';
import { SqliteStore } from '../src/store-sqlite.js';
import { Task, TaskMutationError, TaskStatus, type TaskMetadata } from '../src/task.js';

describe('Task.metadata — R-TASK-16/17', () => {
  it('defaults to an empty, frozen object when not provided', () => {
    const t = Task.bash('echo');
    expect(t.metadata).toEqual({});
    expect(Object.isFrozen(t.metadata)).toBe(true);
  });

  it('accepts a populated object at construction and deep-freezes it', () => {
    const meta = {
      ownerId: 'user-1',
      scope: 'mind',
      tags: ['scheduled', 'cron'],
      details: { source: 'api', retries: 3 },
    };
    const t = Task.bash('echo', { metadata: meta });

    expect(t.metadata.ownerId).toBe('user-1');
    expect(Object.isFrozen(t.metadata)).toBe(true);
    expect(Object.isFrozen(t.metadata.tags)).toBe(true);
    expect(Object.isFrozen(t.metadata.details)).toBe(true);
    expect(() => {
      (t.metadata as Record<string, unknown>).newKey = 'nope';
    }).toThrow(TypeError);
    expect(() => {
      (t.metadata.tags as string[]).push('x');
    }).toThrow(TypeError);
    expect(() => {
      (t.metadata.details as Record<string, unknown>).source = 'changed';
    }).toThrow(TypeError);
  });

  it('setter replaces the bag and re-freezes (mutable-until-SUCCEEDED)', () => {
    const t = Task.bash('echo', { metadata: { a: 1 } });
    t.metadata = { b: 2, c: [1, 2, 3] };
    expect(t.metadata).toEqual({ b: 2, c: [1, 2, 3] });
    expect(Object.isFrozen(t.metadata.c)).toBe(true);
  });

  it('R-SM-09: setter rejects after SUCCEEDED', () => {
    const t = Task.bash('echo', { metadata: { a: 1 } });
    t.transitionTo(TaskStatus.RUNNING);
    t.transitionTo(TaskStatus.SUCCEEDED);
    expect(() => {
      t.metadata = { a: 2 };
    }).toThrow(TaskMutationError);
  });

  describe('validation', () => {
    const reject = (value: unknown, why: string): void => {
      it(`rejects ${why}`, () => {
        expect(() => Task.bash('echo', { metadata: value as TaskMetadata })).toThrow(TypeError);
      });
    };
    reject(null, 'null');
    reject([], 'arrays at top level');
    reject('string', 'a string');
    reject(42, 'a number');
    reject({ k: undefined }, 'undefined-valued keys');
    reject({ k: () => 1 }, 'function values');
    reject({ k: Symbol('s') }, 'symbol values');
    reject({ k: 10n }, 'bigint values');
    reject({ k: Number.NaN }, 'NaN');
    reject({ k: Number.POSITIVE_INFINITY }, '+Infinity');
    reject({ k: Number.NEGATIVE_INFINITY }, '-Infinity');
    reject({ k: new Date() }, 'Date instances (non-plain object)');
    reject({ k: new Map() }, 'Map instances');
    reject({ nested: { bad: undefined } }, 'undefined deep in the tree');

    it('rejects circular references', () => {
      const obj: Record<string, unknown> = { ok: 1 };
      obj.self = obj;
      expect(() => Task.bash('echo', { metadata: obj as TaskMetadata })).toThrow(/circular/);
    });
  });
});

describe('metadata round-trip through stores', () => {
  it('InMemoryStore: live Task reference preserves metadata', () => {
    const store = new InMemoryStore();
    const meta = { ownerId: 'u', tags: ['a', 'b'], n: 42, flag: true, nullish: null };
    const t = Task.bash('echo', { metadata: meta });
    store.tasks.save(t);

    const reloaded = store.tasks.get(t.id)!;
    // InMemoryStore stores live Task refs (R-STORE-11).
    expect(reloaded).toBe(t);
    expect(reloaded.metadata).toEqual(meta);
  });

  describe('SqliteStore', () => {
    let tmp: string;
    let dbCounter = 0;
    beforeEach(async () => {
      tmp = await mkdtemp(join(tmpdir(), 'ttasks-md-'));
    });
    afterEach(async () => {
      await rm(tmp, { recursive: true, force: true });
    });

    it('round-trips arbitrary JSON metadata', () => {
      const path = join(tmp, `md-${String(++dbCounter)}.db`);
      const meta = {
        ownerId: 'mind-7',
        scope: 'user',
        tags: ['scheduled'],
        depth: 2,
        details: { source: 'cron', nested: { deep: [1, null, 'x'] } },
      };

      const a = new SqliteStore({ path });
      const t = Task.bash('echo', { metadata: meta });
      a.tasks.save(t);
      a.close();

      const b = new SqliteStore({ path });
      const reloaded = b.tasks.get(t.id)!;
      expect(reloaded.metadata).toEqual(meta);
      expect(Object.isFrozen(reloaded.metadata)).toBe(true);
      expect(Object.isFrozen(reloaded.metadata.details)).toBe(true);
      b.close();
    });

    it('defaults reloaded metadata to {} when none was set', () => {
      const path = join(tmp, `md-${String(++dbCounter)}.db`);
      const a = new SqliteStore({ path });
      const t = Task.bash('echo');
      a.tasks.save(t);
      a.close();

      const b = new SqliteStore({ path });
      const reloaded = b.tasks.get(t.id)!;
      expect(reloaded.metadata).toEqual({});
      b.close();
    });
  });
});
