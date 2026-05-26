# ttasks-ts Port Roadmap

This roadmap is the working plan for porting the Python `ttasks` behavior to
TypeScript. The authoritative behavioral contract is `docs/compat/`; the Python
implementation and tests are reference evidence, not the spec.

Use this document to resume work after a break: pick the first unchecked phase,
write failing conformance tests for the listed rule IDs, implement until green,
then commit.

## Current status

- Repository: <https://github.com/ianphil/ttasks-ts>
- Package manager: `pnpm`
- Compatibility docs: complete
- Implementation: Phase 8 complete (Copilot integration: provider abstraction, `makeCopilotPromptHandler`/`makeCopilotAgentHandler`, `CopilotAgentSession`, `StubCopilotProvider` for tests)
- All phases complete. No further phases planned.

## Daily resume checklist

From the repo root:

```bash
cd ~/src/ttasks-ts
git status
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Then open:

```text
docs/ROADMAP.md
docs/compat/conformance.md
```

Pick the first unchecked phase below.

## TDD workflow

For every slice:

1. Pick a small set of rule IDs from `docs/compat/conformance.md`.
2. Write Vitest tests whose names include the rule IDs.
3. Run tests and confirm red.
4. Implement the minimum TS behavior.
5. Run:
   ```bash
   pnpm typecheck && pnpm test && pnpm build
   ```
6. Commit with the rule range in the message, e.g.:
   ```bash
   git add src test docs
   git commit -m "Implement task model (R-TASK-01..16, R-SM-01..11)"
   git push
   ```

Prefer small, vertical, spec-backed commits over large rewrites.

## Design decisions to preserve

### Compat docs are the spec

The TypeScript implementation should conform to `docs/compat/*.md`. Python tests
are useful for examples and edge cases, but behavior should be justified by rule
IDs.

### TypeScript should be async-first

Use promises and `AbortSignal` naturally. Do not force Python's synchronous
executor model into TypeScript.

Recommended shapes:

```ts
const result = await executor.execute(task);
const submitted = executor.submit(task); // Promise-like / handle
const result2 = await submitted;
```

Handlers should support sync or async return values:

```ts
export type TaskHandler =
  (context: TaskContext) => TaskHandlerResult | Promise<TaskHandlerResult>;
```

### Cancellation should use AbortSignal

Expose an `AbortSignal` on `TaskContext` in addition to
`context.raiseIfCancelled()`:

```ts
ctx.signal.aborted;
ctx.raiseIfCancelled();
```

Wire executor cancellation to subprocess handlers and Copilot/session handlers
through this signal.

### Identity-by-id

Semantic task identity is `task.id`, not object identity. `===` only means same
JS object. Collections should key by id.

### Result identity within an attempt

Per R-TASK-16, a single attempt's `TaskResult` must be the same object returned
by `execute`, resolved by `submit`, and attached to `task.result`.

## Phases

### Phase 0 — Docs and scaffold

Status: **done**

Artifacts:

- `docs/compat/overview.md`
- `docs/compat/glossary.md`
- `docs/compat/state-machine.md`
- `docs/compat/task.md`
- `docs/compat/events.md`
- `docs/compat/executor.md`
- `docs/compat/graph.md`
- `docs/compat/store.md`
- `docs/compat/copilot.md`
- `docs/compat/conformance.md`

Validation:

```bash
pnpm typecheck && pnpm test && pnpm build
```

### Phase 1 — Task model + state machine

Status: **done**

Implement:

- `TaskStatus`
- `TaskType`
- `TaskResult`
- `Task`
- factory constructors:
  - `Task.bash(...)`
  - `Task.powershell(...)`
  - `Task.prompt(...)`
  - `Task.agent(...)`
- transition validation
- terminal helpers
- `canTransitionTo(...)`

Rule coverage:

- `R-SM-01..11`
- `R-TASK-01..16`

Suggested test files:

```text
test/task.test.ts
test/task-factories.test.ts
test/state-machine.test.ts
test/task-result.test.ts
```

Important edge cases:

- New tasks start `PENDING`.
- Entering `RUNNING` clears stale `result`, `error`, and `blockedBy`.
- `BLOCKED` is terminal but has no result.
- `FAILED -> RUNNING` and carryover `BLOCKED -> RUNNING` are allowed retry
  paths.
- `SUCCEEDED` and `CANCELLED` are sink states.
- Factories preserve payload/title/description/timeout/type.
- `TaskResult` is immutable.
- R-TASK-16 result identity should be asserted later in executor tests too.

Exit criteria:

```bash
pnpm typecheck && pnpm test && pnpm build
```

Commit suggestion:

```bash
git commit -m "Implement task model and state machine (R-TASK-01..16, R-SM-01..11)"
```

### Phase 2 — Event system

Status: **done**

Implement:

- `TaskEventType`
- `TaskEvent`
- `EventBus`
- `subscribe`
- idempotent unsubscribe
- subscriber error isolation
- event error collection

Rule coverage:

- `R-EVT-01..17`

Suggested test file:

```text
test/events.test.ts
```

Important edge cases:

- Event fields are immutable.
- Embedded `task` reference is live, not a snapshot.
- Subscriber errors are captured and do not stop other subscribers.
- Unsubscribe is idempotent.
- `PERSISTENCE_FAILED` shape is supported.
- R-EVT-17: `BLOCKED` child ordering exception must be documented/tested when
  graph exists; add a placeholder test now if useful.

Exit criteria:

```bash
pnpm typecheck && pnpm test && pnpm build
```

Commit suggestion:

```bash
git commit -m "Implement event bus (R-EVT-01..17)"
```

### Phase 3 — Executor core, no subprocess yet

Status: **done**

Implement:

- `TaskExecutor`
- `TaskExecutor.empty()` or equivalent no-default-handler constructor
- handler registry
- `RetryPolicy`
- `TaskContext`
- `execute`
- `submit` basic async execution
- `cancel`
- `markBlocked`
- shutdown/close
- store error capture hooks, using fake/in-memory stores first

Rule coverage:

- `R-EXEC-01..27`
- `R-EXEC-32..34`
- `R-TASK-16`
- selected `R-EVT-*` lifecycle ordering rules

Suggested test files:

```text
test/executor-core.test.ts
test/task-context.test.ts
test/retry-policy.test.ts
test/cancellation.test.ts
```

Important edge cases:

- Missing handler emits exactly `FAILED`, no `STARTED`.
- Already-cancelled task is not run.
- Handler success attaches and returns the same `TaskResult` object.
- Handler failure attaches failed result and rethrows.
- Handler cancellation attaches cancelled result and rethrows cancellation.
- Retries are full independent attempts.
- Cancellation is never retried.
- Backoff observes cancellation promptly.
- `submit` validation happens synchronously.
- Shutdown drains; it does not cancel.

Exit criteria:

```bash
pnpm typecheck && pnpm test && pnpm build
```

Commit suggestion:

```bash
git commit -m "Implement executor core (R-EXEC-01..27, R-EXEC-32..34)"
```

### Phase 4 — In-memory store

Status: **done**

Implement:

- `InMemoryStore`
- `InMemoryTaskCollection`
- `InMemoryGraphCollection`

Rule coverage:

- `R-STORE-01..12`
- `R-STORE-23` as exercised through executor persistence failures

Suggested test file:

```text
test/store-memory.test.ts
```

Important edge cases:

- `tasks` and `graphs` are independent collections.
- `save(obj)` writes under `obj.id`.
- explicit id mismatch is rejected.
- non-Task/non-Graph values are rejected.
- `has` accepts id and object, returns false for other values.
- iteration is insertion order.
- in-memory reads return the exact same object reference.

Exit criteria:

```bash
pnpm typecheck && pnpm test && pnpm build
```

Commit suggestion:

```bash
git commit -m "Implement in-memory store (R-STORE-01..12)"
```

### Phase 5 — Graph scheduler

Status: **done**

Implement:

- `TaskGraph`
- `add`
- dependency/topology views
- finally/optional classification
- `run`
- bounded concurrency
- blocked propagation via `executor.markBlocked`
- carryover-blocked retry behavior
- no-progress guard
- graph persistence at start/end through executor store hook

Rule coverage:

- `R-GRAPH-01..30`
- `R-EVT-17`
- cross-check `R-EXEC-32`
- cross-check `R-STORE-24`

Suggested test files:

```text
test/graph.test.ts
test/graph-run.test.ts
test/graph-e2e.test.ts
```

Important edge cases:

- Validate cycles, self-loop, unregistered deps, stale `RUNNING` before running.
- Normal tasks require all parents `SUCCEEDED`.
- Finally tasks require parents inactive, not succeeded.
- Bad parent blocks normal descendants eagerly.
- Independent branches continue.
- Already-`SUCCEEDED` tasks satisfy dependencies on re-run.
- Entering-run `BLOCKED` tasks may recover; in-run `BLOCKED` tasks do not retry
  until the next run.
- `ok` ignores optional finally failures but not required failures/blocks/errors.
- `errors` resets each run.
- Empty graph runs cleanly and `ok === true`.

Exit criteria:

```bash
pnpm typecheck && pnpm test && pnpm build
```

Commit suggestion:

```bash
git commit -m "Implement graph scheduler (R-GRAPH-01..30)"
```

### Phase 6 — Node subprocess handlers

Status: **done**

Implement:

- built-in `BASH` handler via `child_process.spawn`
- built-in `POWERSHELL` handler via `pwsh -Command`
- stdout/stderr streaming as `OUTPUT` events
- timeout handling
- cancellation handling
- non-zero exit handling
- lossy-tolerant UTF-8 decoding where practical

Rule coverage:

- `R-EXEC-28..31`
- `R-EVT-14`
- relevant `R-TASK-14` termination reasons

Suggested test file:

```text
test/executor-subprocess.test.ts
```

Important edge cases:

- stdout and stderr are separate event streams.
- final `TaskResult.output` and `TaskResult.error` retain collected output.
- non-zero exit -> `FAILED`, `terminationReason = "exit_code"`.
- timeout -> process killed, partial output retained,
  `terminationReason = "timeout"`.
- cancellation -> process killed, `terminationReason = "cancelled"`.
- `OUTPUT` events happen before terminal events.

Exit criteria:

```bash
pnpm typecheck && pnpm test && pnpm build
```

Commit suggestion:

```bash
git commit -m "Implement subprocess handlers (R-EXEC-28..31)"
```

### Phase 7 — Durable store

Status: **done**

Implement a durable backend. SQLite is canonical but not mandatory.
Recommended Node options:

- `better-sqlite3` for synchronous, simple SQLite access
- `sqlite` / `sqlite3` for async access
- `node:sqlite` if available and acceptable for supported Node versions

Rule coverage:

- `R-STORE-13..24`

Suggested test file:

```text
test/store-sqlite.test.ts
```

Important edge cases:

- Durable reads return detached snapshots.
- Task roundtrip preserves all persisted fields except `TaskResult.raw` may be
  dropped.
- Graph roundtrip preserves id/title/createdAt/membership/order/edges/finally
  metadata.
- Graph save atomically saves member tasks and graph topology.
- Deleting a graph does not delete member tasks.
- Schema version mismatch refuses to open unless destructive migration is
  explicitly requested.
- Destructive migration warns and rebuilds.
- Concurrent executor workers do not corrupt writes.

Exit criteria:

```bash
pnpm typecheck && pnpm test && pnpm build
```

Commit suggestion:

```bash
git commit -m "Implement durable store (R-STORE-13..24)"
```

### Phase 8 — Copilot / agent integration

Status: **done**

Rule coverage:

- `R-COP-01..25`

Suggested test files:

```text
test/copilot-handlers.test.ts
test/copilot-session.test.ts
test/copilot-e2e.test.ts
```

Recommended design:

```ts
export interface CopilotProvider {
  createSession(options: CopilotSessionOptions): Promise<CopilotSessionHandle>;
}

export interface CopilotSessionHandle {
  sendAndWait(prompt: string, options?: {
    timeout?: number | null;
    signal?: AbortSignal;
  }): Promise<unknown>;
  abort?(): Promise<void>;
  close(): Promise<void>;
  onEvent?(handler: (event: unknown) => void): () => void;
}
```

Important edge cases:

- PROMPT is one turn, tools disabled.
- AGENT is one turn, tools enabled.
- Empty/non-text response -> `""`, not failure.
- Provider errors propagate and become task failures.
- Task timeout overrides handler/session default.
- Shared session serializes turns.
- Shared session preserves conversation state across turns.
- Event subscriber errors are captured in `eventErrors` and isolated.
- Cancellation aborts the active turn if possible.

Exit criteria:

```bash
pnpm typecheck && pnpm test && pnpm build
```

Commit suggestion:

```bash
git commit -m "Implement Copilot handlers and session (R-COP-01..25)"
```

## Suggested final conformance/e2e pass

After all phases, add a final cross-area test suite inspired by Python
`tests/test_e2e.py`:

```text
test/e2e-subprocess.test.ts
test/e2e-graph.test.ts
test/e2e-store.test.ts
test/e2e-copilot.test.ts
```

Scenarios to port:

- live bash streams stdout/stderr events and retains output
- submitted bash executes and `task.result === awaitedResult`
- shutdown drains submitted subprocess
- real bash retry recovers after first failure
- diamond with finally cleanup and progress event
- failure cascade with optional finally
- transition zoo
- transition zoo persisted through durable store
- mixed BASH → PROMPT → AGENT → BASH workflow
- shared CopilotAgentSession multi-turn graph

Gate slow/live/provider-dependent tests behind an environment variable, e.g.:

```bash
TTASKS_LIVE=1 pnpm test
TTASKS_COPILOT_LIVE=1 pnpm test
```

## Open questions for the TS port

Resolve these before implementing the relevant phase:

1. **Missing store keys:** return `undefined`, throw `NotFoundError`, or expose
   both? See R-STORE-07.
2. **Submitted task handle:** should `submit` return a plain `Promise`, or a
   custom promise-like with `cancel()`? If custom, document future-side cancel
   semantics for R-EXEC-24.
3. **Default handlers:** should `new TaskExecutor()` register BASH/POWERSHELL
   only, or also PROMPT/AGENT stubs? See R-EXEC-03 and R-COP-25.
4. **Durable store dependency:** use SQLite now, defer, or support pluggable
   durable adapters?
5. **Copilot provider:** CLI bridge, direct SDK, MCP runtime, or stub-first?

## Quick file map

Expected implementation files:

```text
src/task.ts        # TaskStatus, TaskType, TaskResult, Task
src/events.ts      # TaskEventType, TaskEvent, EventBus
src/executor.ts    # TaskExecutor, TaskContext, RetryPolicy, errors
src/graph.ts       # TaskGraph
src/store.ts       # Store interfaces + InMemoryStore
src/sqlite.ts      # Durable store, if implemented separately
src/copilot.ts     # Copilot handlers/session/provider abstraction
src/index.ts       # Public exports
```

Expected test files:

```text
test/task.test.ts
test/task-factories.test.ts
test/state-machine.test.ts
test/task-result.test.ts
test/events.test.ts
test/executor-core.test.ts
test/task-context.test.ts
test/retry-policy.test.ts
test/cancellation.test.ts
test/store-memory.test.ts
test/graph.test.ts
test/graph-run.test.ts
test/executor-subprocess.test.ts
test/store-sqlite.test.ts
test/copilot-handlers.test.ts
test/copilot-session.test.ts
```

## Definition of done

The TypeScript port is considered behaviorally complete when:

- every rule in `docs/compat/conformance.md` is implemented, explicitly marked
  N/A for a documented TS-native reason, or documented as intentionally omitted
  under a `MAY` rule;
- every `MUST` rule has at least one TS test or an explicit cross-test note;
- all tests, typecheck, and build pass;
- README documents major TS-specific choices:
  - async-first executor,
  - cancellation/AbortSignal,
  - missing-key behavior,
  - installed default handlers,
  - durable store availability,
  - Copilot provider availability.
