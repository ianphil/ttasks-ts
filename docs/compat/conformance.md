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

_Pending._

### Events (`events.md`)

_Pending._

### Executor (`executor.md`)

_Pending._

### Graph (`graph.md`)

_Pending._

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
