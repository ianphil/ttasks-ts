// Durable SQLite-backed store using Node's built-in `node:sqlite`.
// Implements R-STORE-13..24.

import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { TaskGraph, type TaskGraphSnapshot } from './graph.js';
import {
  StoreIdMismatchError,
  StoreKeyError,
  type GraphStore,
  type Store,
  type TaskStore,
} from './store.js';
import {
  Task,
  TaskResult,
  TaskStatus,
  TaskType,
  type TaskSnapshot,
  type TerminationReason,
} from './task.js';

const SCHEMA_VERSION = 1;

/** @category Errors */
export class StoreSchemaMismatchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'StoreSchemaMismatchError';
  }
}

/** @category Stores */
export interface SqliteStoreOptions {
  // Path to a sqlite file or ':memory:' for in-process.
  path: string;
  // R-STORE-21: opt-in destructive migration. Drops and rebuilds known
  // tables when the embedded schema version does not match.
  allowDestructiveMigration?: boolean;
}

interface MetaRow {
  value: string;
}

interface TaskRow {
  id: string;
  type: string;
  title: string;
  description: string;
  payload: string;
  timeout: number | null;
  created_at: string;
  status: string;
  error: string | null;
  blocked_by: string | null;
  result_json: string | null;
}

interface GraphRow {
  id: string;
  title: string;
  created_at: string;
}

interface MemberRow {
  task_id: string;
  position: number;
  is_finally: number;
  is_optional: number;
}

interface EdgeRow {
  task_id: string;
  parent_id: string;
  position: number;
}

function nowIso(d: Date): string {
  return d.toISOString();
}

function parseDate(iso: string): Date {
  return new Date(iso);
}

function serializeResult(result: TaskResult | null | undefined): string | null {
  if (result == null) return null;
  return JSON.stringify({
    taskId: result.taskId,
    status: result.status,
    startedAt: result.startedAt.toISOString(),
    finishedAt: result.finishedAt.toISOString(),
    duration: result.duration,
    output: result.output,
    error: result.error,
    returncode: result.returncode,
    terminationReason: result.terminationReason,
  });
}

interface SerializedResult {
  taskId: string;
  status: TaskStatus;
  startedAt: string;
  finishedAt: string;
  duration: number;
  output: string;
  error: string | null;
  returncode: number | null;
  terminationReason: TerminationReason;
}

function deserializeResult(json: string | null): TaskResult | null {
  if (json === null) return null;
  const r = JSON.parse(json) as SerializedResult;
  // R-STORE-14: raw MAY be dropped on roundtrip; reconstruct as null.
  return new TaskResult({
    taskId: r.taskId,
    status: r.status,
    startedAt: new Date(r.startedAt),
    finishedAt: new Date(r.finishedAt),
    duration: r.duration,
    output: r.output,
    error: r.error,
    raw: null,
    returncode: r.returncode,
    terminationReason: r.terminationReason,
  });
}

function rowToTask(row: TaskRow): Task {
  const snapshot: TaskSnapshot = {
    id: row.id,
    type: row.type as TaskType,
    title: row.title,
    description: row.description,
    payload: row.payload,
    timeout: row.timeout ?? undefined,
    createdAt: parseDate(row.created_at),
    status: row.status as TaskStatus,
    error: row.error ?? undefined,
    blockedBy: row.blocked_by ?? undefined,
    result: deserializeResult(row.result_json),
  };
  return Task.restore(snapshot);
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  payload TEXT NOT NULL,
  timeout REAL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  blocked_by TEXT,
  result_json TEXT,
  insert_order INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS graphs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  insert_order INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS graph_members (
  graph_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  is_finally INTEGER NOT NULL,
  is_optional INTEGER NOT NULL,
  PRIMARY KEY (graph_id, task_id),
  FOREIGN KEY (graph_id) REFERENCES graphs(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS graph_edges (
  graph_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (graph_id, task_id, parent_id),
  FOREIGN KEY (graph_id) REFERENCES graphs(id) ON DELETE CASCADE
);
`;

const KNOWN_TABLES = ['meta', 'tasks', 'graphs', 'graph_members', 'graph_edges'];

interface PreparedStatements {
  selectTask: StatementSync;
  insertTask: StatementSync;
  deleteTask: StatementSync;
  hasTask: StatementSync;
  countTasks: StatementSync;
  listTaskIds: StatementSync;
  nextTaskOrder: StatementSync;

  selectGraph: StatementSync;
  insertGraph: StatementSync;
  deleteGraph: StatementSync;
  hasGraph: StatementSync;
  countGraphs: StatementSync;
  listGraphIds: StatementSync;
  nextGraphOrder: StatementSync;

  deleteMembers: StatementSync;
  insertMember: StatementSync;
  listMembers: StatementSync;
  deleteEdges: StatementSync;
  insertEdge: StatementSync;
  listEdges: StatementSync;
}

function prepareStatements(db: DatabaseSync): PreparedStatements {
  return {
    selectTask: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    insertTask: db.prepare(
      `INSERT INTO tasks
       (id, type, title, description, payload, timeout, created_at, status, error, blocked_by, result_json, insert_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         type=excluded.type,
         title=excluded.title,
         description=excluded.description,
         payload=excluded.payload,
         timeout=excluded.timeout,
         created_at=excluded.created_at,
         status=excluded.status,
         error=excluded.error,
         blocked_by=excluded.blocked_by,
         result_json=excluded.result_json`,
    ),
    deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),
    hasTask: db.prepare('SELECT 1 FROM tasks WHERE id = ?'),
    countTasks: db.prepare('SELECT COUNT(*) AS n FROM tasks'),
    listTaskIds: db.prepare('SELECT id FROM tasks ORDER BY insert_order ASC'),
    nextTaskOrder: db.prepare(
      'SELECT COALESCE(MAX(insert_order), 0) + 1 AS n FROM tasks',
    ),

    selectGraph: db.prepare('SELECT * FROM graphs WHERE id = ?'),
    insertGraph: db.prepare(
      `INSERT INTO graphs (id, title, created_at, insert_order)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title,
         created_at=excluded.created_at`,
    ),
    deleteGraph: db.prepare('DELETE FROM graphs WHERE id = ?'),
    hasGraph: db.prepare('SELECT 1 FROM graphs WHERE id = ?'),
    countGraphs: db.prepare('SELECT COUNT(*) AS n FROM graphs'),
    listGraphIds: db.prepare('SELECT id FROM graphs ORDER BY insert_order ASC'),
    nextGraphOrder: db.prepare(
      'SELECT COALESCE(MAX(insert_order), 0) + 1 AS n FROM graphs',
    ),

    deleteMembers: db.prepare('DELETE FROM graph_members WHERE graph_id = ?'),
    insertMember: db.prepare(
      `INSERT INTO graph_members (graph_id, task_id, position, is_finally, is_optional)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    listMembers: db.prepare(
      'SELECT task_id, position, is_finally, is_optional FROM graph_members WHERE graph_id = ? ORDER BY position ASC',
    ),
    deleteEdges: db.prepare('DELETE FROM graph_edges WHERE graph_id = ?'),
    insertEdge: db.prepare(
      `INSERT INTO graph_edges (graph_id, task_id, parent_id, position)
       VALUES (?, ?, ?, ?)`,
    ),
    listEdges: db.prepare(
      'SELECT task_id, parent_id, position FROM graph_edges WHERE graph_id = ? AND task_id = ? ORDER BY position ASC',
    ),
  };
}

class SqliteTaskCollection implements TaskStore {
  readonly #db: DatabaseSync;
  readonly #stmts: PreparedStatements;

  public constructor(db: DatabaseSync, stmts: PreparedStatements) {
    this.#db = db;
    this.#stmts = stmts;
  }

  public get size(): number {
    const row = this.#stmts.countTasks.get() as { n: number };
    return row.n;
  }

  public save(task: Task): void {
    if (!(task instanceof Task)) {
      throw new TypeError('save expects a Task');
    }
    this.#upsert(task);
  }

  public setItem(id: string, task: Task): void {
    if (!(task instanceof Task)) {
      throw new TypeError('value must be a Task');
    }
    if (id !== task.id) {
      throw new StoreIdMismatchError(`id mismatch: ${id} !== task.id ${task.id}`);
    }
    this.#upsert(task);
  }

  #upsert(task: Task): void {
    const next = this.#stmts.nextTaskOrder.get() as { n: number };
    const exists = this.#stmts.hasTask.get(task.id) !== undefined;
    const order = exists ? null : next.n;
    // For existing rows the ON CONFLICT path ignores insert_order; supply
    // current next.n as a harmless value when present.
    this.#stmts.insertTask.run(
      task.id,
      task.type,
      task.title,
      task.description,
      task.payload,
      task.timeout ?? null,
      nowIso(task.createdAt),
      task.status,
      task.error ?? null,
      task.blockedBy ?? null,
      serializeResult(task.result),
      order ?? next.n,
    );
  }

  public get(id: string): Task | undefined {
    const row = this.#stmts.selectTask.get(id) as TaskRow | undefined;
    if (row === undefined) return undefined;
    return rowToTask(row);
  }

  public has(key: unknown): boolean {
    if (typeof key === 'string') {
      return this.#stmts.hasTask.get(key) !== undefined;
    }
    if (key instanceof Task) {
      return this.#stmts.hasTask.get(key.id) !== undefined;
    }
    return false;
  }

  public delete(key: string | Task): void {
    const id = key instanceof Task ? key.id : key;
    if (typeof id !== 'string' || this.#stmts.hasTask.get(id) === undefined) {
      throw new StoreKeyError(`no such task: ${String(id)}`);
    }
    this.#stmts.deleteTask.run(id);
  }

  public *ids(): IterableIterator<string> {
    const rows = this.#stmts.listTaskIds.all() as { id: string }[];
    for (const r of rows) yield r.id;
  }

  public *values(): IterableIterator<Task> {
    for (const id of this.ids()) {
      const t = this.get(id);
      if (t !== undefined) yield t;
    }
  }

  public [Symbol.iterator](): IterableIterator<string> {
    return this.ids();
  }
}

class SqliteGraphCollection implements GraphStore {
  readonly #db: DatabaseSync;
  readonly #stmts: PreparedStatements;
  readonly #tasks: SqliteTaskCollection;

  public constructor(
    db: DatabaseSync,
    stmts: PreparedStatements,
    tasks: SqliteTaskCollection,
  ) {
    this.#db = db;
    this.#stmts = stmts;
    this.#tasks = tasks;
  }

  public get size(): number {
    const row = this.#stmts.countGraphs.get() as { n: number };
    return row.n;
  }

  public save(graph: TaskGraph): void {
    if (!(graph instanceof TaskGraph)) {
      throw new TypeError('save expects a TaskGraph');
    }
    this.#upsert(graph);
  }

  public setItem(id: string, graph: TaskGraph): void {
    if (!(graph instanceof TaskGraph)) {
      throw new TypeError('value must be a TaskGraph');
    }
    if (id !== graph.id) {
      throw new StoreIdMismatchError(`id mismatch: ${id} !== graph.id ${graph.id}`);
    }
    this.#upsert(graph);
  }

  // R-STORE-16: graph + members + edges saved atomically in one transaction.
  #upsert(graph: TaskGraph): void {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const next = this.#stmts.nextGraphOrder.get() as { n: number };
      this.#stmts.insertGraph.run(
        graph.id,
        graph.title,
        nowIso(graph.createdAt),
        next.n,
      );
      this.#stmts.deleteMembers.run(graph.id);
      this.#stmts.deleteEdges.run(graph.id);
      const tasks = graph.tasks;
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i] as Task;
        this.#tasks.save(t);
        this.#stmts.insertMember.run(
          graph.id,
          t.id,
          i,
          graph.isFinally(t) ? 1 : 0,
          graph.isOptional(t) ? 1 : 0,
        );
        const deps = graph.dependencies(t);
        for (let p = 0; p < deps.length; p++) {
          this.#stmts.insertEdge.run(graph.id, t.id, (deps[p] as Task).id, p);
        }
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  public get(id: string): TaskGraph | undefined {
    const row = this.#stmts.selectGraph.get(id) as GraphRow | undefined;
    if (row === undefined) return undefined;
    const members = this.#stmts.listMembers.all(id) as unknown as MemberRow[];
    const memberTasks = new Map<string, Task>();
    for (const m of members) {
      const t = this.#tasks.get(m.task_id);
      if (t !== undefined) memberTasks.set(m.task_id, t);
    }
    const entries = members.map((m) => {
      const edges = this.#stmts.listEdges.all(id, m.task_id) as unknown as EdgeRow[];
      const t = memberTasks.get(m.task_id);
      if (t === undefined) {
        throw new Error(`graph ${id}: member task ${m.task_id} not found`);
      }
      return {
        task: t,
        after: edges.map((e) => e.parent_id),
        isFinally: m.is_finally === 1,
        required: m.is_optional === 0,
      };
    });
    const snapshot: TaskGraphSnapshot = {
      id: row.id,
      title: row.title,
      createdAt: parseDate(row.created_at),
      entries,
    };
    return TaskGraph.restore(snapshot);
  }

  public has(key: unknown): boolean {
    if (typeof key === 'string') {
      return this.#stmts.hasGraph.get(key) !== undefined;
    }
    if (key instanceof TaskGraph) {
      return this.#stmts.hasGraph.get(key.id) !== undefined;
    }
    return false;
  }

  public delete(key: string | TaskGraph): void {
    const id = key instanceof TaskGraph ? key.id : key;
    if (typeof id !== 'string' || this.#stmts.hasGraph.get(id) === undefined) {
      throw new StoreKeyError(`no such graph: ${String(id)}`);
    }
    // R-STORE: deleting a graph does not delete member tasks.
    this.#db.exec('BEGIN');
    try {
      this.#stmts.deleteMembers.run(id);
      this.#stmts.deleteEdges.run(id);
      this.#stmts.deleteGraph.run(id);
      this.#db.exec('COMMIT');
    } catch (err) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  public *ids(): IterableIterator<string> {
    const rows = this.#stmts.listGraphIds.all() as { id: string }[];
    for (const r of rows) yield r.id;
  }

  public *values(): IterableIterator<TaskGraph> {
    for (const id of this.ids()) {
      const g = this.get(id);
      if (g !== undefined) yield g;
    }
  }

  public [Symbol.iterator](): IterableIterator<string> {
    return this.ids();
  }
}

function ensureSchema(
  db: DatabaseSync,
  allowDestructive: boolean,
): void {
  // Discover existing known tables.
  const existing = (db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${KNOWN_TABLES.map(() => '?').join(',')})`,
    )
    .all(...KNOWN_TABLES) as { name: string }[]).map((r) => r.name);

  if (existing.length === 0) {
    // R-STORE-19: fresh empty storage is accepted.
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
      'schema_version',
      String(SCHEMA_VERSION),
    );
    return;
  }

  // Some known tables exist. Check version.
  let version: number | null = null;
  if (existing.includes('meta')) {
    const row = db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('schema_version') as MetaRow | undefined;
    if (row !== undefined) version = Number(row.value);
  }

  if (version === SCHEMA_VERSION) {
    // R-STORE-19 path 2: schema matches; ensure any missing tables exist
    // (defensive: a partial install). All CREATE TABLE statements use
    // IF NOT EXISTS so this is safe.
    db.exec(SCHEMA_SQL);
    return;
  }

  // R-STORE-20: mismatched / missing version row with known tables present.
  if (!allowDestructive) {
    throw new StoreSchemaMismatchError(
      `Schema version mismatch (found ${version === null ? 'none' : String(version)}, expected ${String(SCHEMA_VERSION)}). ` +
        'Pass allowDestructiveMigration: true to drop and rebuild the known tables.',
    );
  }

  // R-STORE-21: explicit destructive migration; warn loudly.
  // eslint-disable-next-line no-console
  console.warn(
    `[ttasks-ts] Destructive migration: dropping known tables in this database ` +
      `(version ${version === null ? 'none' : String(version)} -> ${String(SCHEMA_VERSION)})`,
  );
  for (const name of [...KNOWN_TABLES].reverse()) {
    db.exec(`DROP TABLE IF EXISTS ${name}`);
  }
  db.exec(SCHEMA_SQL);
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
    'schema_version',
    String(SCHEMA_VERSION),
  );
}

// R-STORE-01, R-STORE-13..24: durable SQLite-backed store.
/** @category Stores */
export class SqliteStore implements Store {
  readonly #db: DatabaseSync;
  public readonly tasks: TaskStore;
  public readonly graphs: GraphStore;

  public constructor(options: SqliteStoreOptions) {
    this.#db = new DatabaseSync(options.path);
    this.#db.exec('PRAGMA foreign_keys = ON');
    // R-STORE-22: WAL improves concurrent reader/writer behavior on disk.
    if (options.path !== ':memory:') {
      try {
        this.#db.exec('PRAGMA journal_mode = WAL');
      } catch {
        /* not all environments support WAL */
      }
    }
    ensureSchema(this.#db, options.allowDestructiveMigration === true);
    const stmts = prepareStatements(this.#db);
    const tasks = new SqliteTaskCollection(this.#db, stmts);
    this.tasks = tasks;
    this.graphs = new SqliteGraphCollection(this.#db, stmts, tasks);
  }

  public close(): void {
    this.#db.close();
  }
}
