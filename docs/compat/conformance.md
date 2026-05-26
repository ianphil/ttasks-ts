# Conformance index

This is the master index of every compat rule. Each rule has:

- a stable id (`R-AREA-NN`)
- a conformance level (`MUST` / `SHOULD` / `MAY` / `IMPL-DEFINED`)
- a one-line summary
- a link to its defining document
- at least one Python reference test (when one exists)

Implementations claim conformance by passing the scenarios in the linked
documents, not by hand-asserting against this index.

## How to read this file

- New rules are appended; existing ids are stable forever.
- A rule whose level changes gets a note in the **Notes** column.
- A rule that is retired stays in the index, level `RETIRED`, with the
  release that retired it.

## Rule index

### State machine (`state-machine.md`)

| ID        | Level       | Summary                                             | Notes |
| --------- | ----------- | --------------------------------------------------- | ----- |
| R-SM-01   | MUST        | Allowed transitions are exhaustive                  |       |
| R-SM-02   | MUST        | Sink states are terminal                            |       |
| R-SM-03   | MUST        | Entering RUNNING clears prior-run carryover         |       |
| R-SM-04   | MUST        | Entering SUCCEEDED clears error                     |       |
| R-SM-05   | MUST        | FAILED preserves error for inspection               |       |
| R-SM-06   | MUST        | Cancellation preserves prior error                  |       |
| R-SM-07   | MUST        | Cancellation is idempotent                          |       |
| R-SM-08   | MUST        | FAILED and BLOCKED are retryable                    |       |
| R-SM-09   | MUST        | SUCCEEDED tasks are immutable                       |       |
| R-SM-10   | MUST        | Task identity is stable                             |       |
| R-SM-11   | SHOULD      | Status predicates agree with the table              |       |

### Task (`task.md`)

| ID         | Level  | Summary                                                       | Notes |
| ---------- | ------ | ------------------------------------------------------------- | ----- |
| R-TASK-01  | MUST   | Task type is required and constrained                         |       |
| R-TASK-02  | MUST   | Timeout, if present, is positive                              |       |
| R-TASK-03  | MUST   | Timeout defaults to unbounded                                 |       |
| R-TASK-04  | MUST   | Title and description default to empty                        |       |
| R-TASK-05  | MUST   | Each task gets a fresh identity                               |       |
| R-TASK-06  | MUST   | Identity equality and membership                              |       |
| R-TASK-07  | MUST   | Status is read-only externally                                |       |
| R-TASK-08  | MUST   | Result and blockedBy are read-only externally                 |       |
| R-TASK-09  | MUST   | Non-SUCCEEDED tasks remain editable for retry                 |       |
| R-TASK-10  | MUST   | Built-in task type set                                        |       |
| R-TASK-11  | SHOULD | Type-specific factory constructors                            |       |
| R-TASK-12  | MUST   | Result attached on every non-BLOCKED terminal transition      |       |
| R-TASK-13  | MUST   | TaskResult is immutable                                       |       |
| R-TASK-14  | MUST   | TaskResult normalization                                      |       |
| R-TASK-15  | SHOULD | Repr / display is identity-first                              |       |

### Events (`events.md`)

| ID         | Level  | Summary                                                       | Notes |
| ---------- | ------ | ------------------------------------------------------------- | ----- |
| R-EVT-01   | MUST   | Event types are exhaustive                                    |       |
| R-EVT-02   | MUST   | Status-changing events fire after the transition is applied  |       |
| R-EVT-03   | MUST   | Terminal result attached before terminal event                |       |
| R-EVT-04   | MUST   | STARTED precedes streaming precedes terminal                  |       |
| R-EVT-05   | MUST   | Never-ran terminals skip STARTED                              |       |
| R-EVT-06   | MUST   | Retries are independent attempts                              |       |
| R-EVT-07   | MUST   | Subscriber isolation                                          |       |
| R-EVT-08   | MUST   | Subscription returns idempotent unsubscribe                   |       |
| R-EVT-09   | SHOULD | Scoped subscription helper                                    |       |
| R-EVT-10   | SHOULD | Subscriber rejection of non-callables                         |       |
| R-EVT-11   | MUST   | Events are immutable                                          |       |
| R-EVT-12   | MUST   | `previousStatus` is correct                                   |       |
| R-EVT-13   | MUST   | Persistence failures surface as events, not exceptions        |       |
| R-EVT-14   | MUST   | OUTPUT carries stream and chunk                               |       |
| R-EVT-15   | MUST   | PROGRESS carries percent and/or message                       |       |
| R-EVT-16   | MUST   | Bus collects subscriber errors                                |       |

### Executor (`executor.md`)

| ID         | Level  | Summary                                                       | Notes |
| ---------- | ------ | ------------------------------------------------------------- | ----- |
| R-EXEC-01  | MUST   | Handler registration is type-keyed                            |       |
| R-EXEC-02  | MUST   | `isRegistered` reflects registration state                    |       |
| R-EXEC-03  | SHOULD | Default handlers for built-in types                           |       |
| R-EXEC-04  | MUST   | `execute` requires a Task                                     |       |
| R-EXEC-05  | MUST   | `execute` drives the canonical lifecycle                      |       |
| R-EXEC-06  | MUST   | Missing handler terminalizes without RUNNING                  |       |
| R-EXEC-07  | MUST   | `execute` refuses already-CANCELLED tasks                     |       |
| R-EXEC-08  | MUST   | `execute` refuses non-runnable status                         |       |
| R-EXEC-09  | MUST   | Context exposes read-only task view                           |       |
| R-EXEC-10  | MUST   | Context exposes upstream tasks read-only                      |       |
| R-EXEC-11  | MUST   | Progress requires an executor-bound emitter                   |       |
| R-EXEC-12  | MUST   | Progress is rejected after cancellation                       |       |
| R-EXEC-13  | MUST   | `cancel` is the cancellation entry point                      |       |
| R-EXEC-14  | MUST   | Cancelled-pending result fields                               |       |
| R-EXEC-15  | MUST   | Cancel persists to the store                                  |       |
| R-EXEC-16  | MUST   | RetryPolicy validation                                        |       |
| R-EXEC-17  | MUST   | Retries re-run until success or exhaustion                    |       |
| R-EXEC-18  | MUST   | Cancellation is never retried                                 |       |
| R-EXEC-19  | MUST   | Missing handler does not retry                                |       |
| R-EXEC-20  | MUST   | Backoff is observed between attempts                          |       |
| R-EXEC-21  | MUST   | Cancellation during backoff is honored promptly               |       |
| R-EXEC-22  | MUST   | `submit` returns a future-like                                |       |
| R-EXEC-23  | MUST   | Submitted execution is consistent with synchronous            |       |
| R-EXEC-24  | MUST   | Queued cancel before run                                      |       |
| R-EXEC-25  | MUST   | Shutdown is idempotent and drains submitted work              |       |
| R-EXEC-26  | MUST   | Shutdown from a worker is non-deadlocking                     |       |
| R-EXEC-27  | SHOULD | Resource-cleanup integration                                  |       |
| R-EXEC-28  | MUST   | Built-in shell handlers stream output                         |       |
| R-EXEC-29  | MUST   | Timeout terminates the process and yields partial output      |       |
| R-EXEC-30  | MUST   | Cancellation terminates the process                           |       |
| R-EXEC-31  | SHOULD | Output decode is lossy-tolerant                               |       |
| R-EXEC-32  | MUST   | `markBlocked` is the graph seam                               |       |
| R-EXEC-33  | MUST   | Auto-persistence on every transition                          |       |
| R-EXEC-34  | MUST   | Progress and output are not persisted                         |       |

### Graph (`graph.md`)

| ID          | Level  | Summary                                                       | Notes |
| ----------- | ------ | ------------------------------------------------------------- | ----- |
| R-GRAPH-01  | MUST   | Graph has a stable identity                                   |       |
| R-GRAPH-02  | MUST   | Title is an optional string                                   |       |
| R-GRAPH-03  | MUST   | `createdAt` is set at construction                            |       |
| R-GRAPH-04  | MUST   | `add` requires a Task                                         |       |
| R-GRAPH-05  | MUST   | `add` deduplicates dependencies                               |       |
| R-GRAPH-06  | MUST   | `finally_` and `required` flags are validated                 |       |
| R-GRAPH-07  | SHOULD | `__setitem__` is a sugar form of `add`                        |       |
| R-GRAPH-08  | MUST   | `dependencies` returns direct upstream tasks                  |       |
| R-GRAPH-09  | MUST   | `roots` and `leaves`                                          |       |
| R-GRAPH-10  | MUST   | `run` validates max workers                                   |       |
| R-GRAPH-11  | MUST   | `run` rejects unregistered dependencies                       |       |
| R-GRAPH-12  | MUST   | `run` rejects cycles                                          |       |
| R-GRAPH-13  | MUST   | `run` rejects stale RUNNING tasks                             |       |
| R-GRAPH-14  | MUST   | Normal tasks ready when all parents SUCCEEDED                 |       |
| R-GRAPH-15  | MUST   | Finally tasks ready when all parents inactive                 |       |
| R-GRAPH-16  | MUST   | Bad parent blocks normal descendants                          |       |
| R-GRAPH-17  | MUST   | Blocking does not propagate through finally tasks             |       |
| R-GRAPH-18  | MUST   | Independent branches are unaffected                           |       |
| R-GRAPH-19  | MUST   | Failure terminates the run promptly                           |       |
| R-GRAPH-20  | MUST   | Parallelism is bounded by `maxWorkers`                        |       |
| R-GRAPH-21  | MUST   | Already-SUCCEEDED tasks count as satisfied dependencies       |       |
| R-GRAPH-22  | MUST   | Carryover-blocked tasks are retry-eligible                    |       |
| R-GRAPH-23  | MUST   | Blocked view resets at start of run                           |       |
| R-GRAPH-24  | MUST   | Graph passes direct upstream task refs to handlers            |       |
| R-GRAPH-25  | MUST   | Status views reflect graph members only                       |       |
| R-GRAPH-26  | MUST   | `errors` records executor-thrown errors per task              |       |
| R-GRAPH-27  | MUST   | `ok` is the authoritative verdict                             |       |
| R-GRAPH-28  | MUST   | Graph is persisted before and after run                       |       |
| R-GRAPH-29  | MUST   | `run` returns the graph for chaining                          |       |
| R-GRAPH-30  | MUST   | Empty graph runs cleanly                                      |       |

### Store (`store.md`)

_Pending._

### Copilot (`copilot.md`)

_Pending._

## Reserved id prefixes

| Prefix    | Area               |
| --------- | ------------------ |
| `R-SM-`   | State machine      |
| `R-TASK-` | Task domain object |
| `R-EVT-`  | Events             |
| `R-EXEC-` | Executor           |
| `R-GRAPH-`| Graph              |
| `R-STORE-`| Store              |
| `R-COP-`  | Copilot session    |

New areas append a new prefix; existing prefixes never change meaning.

## Conformance claim template

When a non-reference implementation wants to claim conformance for a release,
it should publish a table of the form:

| ID        | Status              | Evidence                                              |
| --------- | ------------------- | ----------------------------------------------------- |
| R-SM-01   | conforming          | `test/state-machine/allowed-transitions.test.ts`      |
| R-SM-02   | conforming          | `test/state-machine/sink-states.test.ts`              |
| R-SM-03   | conforming          | `test/state-machine/running-clears-carryover.test.ts` |
| ...       | ...                 | ...                                                   |

Allowed statuses in a claim:

- `conforming` — implementation satisfies the rule
- `partial` — implementation satisfies a subset; partial behavior described
- `deviated` — implementation intentionally differs; deviation documented
- `unimplemented` — feature not present yet
- `n/a` — rule does not apply (rare; usually `IMPL-DEFINED`)
