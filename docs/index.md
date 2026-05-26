# ttasks-ts

`ttasks-ts` is a small TypeScript task ledger, executor, and DAG workflow
library, with first-class support for GitHub Copilot agent sessions.

Use it when you want to model units of work as durable TypeScript objects,
execute them through explicit handlers, observe progress and output, and
compose them into dependency graphs.

## Start here

- [Quickstart](quickstart.md): run one task and one graph.
- [Task execution tutorial](tutorials/task-execution.md): tasks, handlers,
  results, events, and persistence.
- [Graph workflows tutorial](tutorials/graph-workflows.md): build DAGs with
  dependencies and outcome views.
- [Copilot tutorial](tutorials/copilot.md): one-shot prompts and shared agent
  sessions.
- [Finally tasks pattern](patterns/finally-tasks.md): cleanup, reporting, and
  recommendation tasks after success or failure.
- [Progress and output](patterns/progress-and-output.md): subscribe to
  lifecycle, progress, and streamed subprocess output.
- [Retries and cancellation](patterns/retries-and-cancellation.md): retry
  policies, cancellation via `AbortSignal`, and timeouts.

## API reference

The API reference is generated from TSDoc with [TypeDoc](https://typedoc.org/).

```bash
pnpm docs
```

See [reference/api.md](reference/api.md) for details.

## Behavioral spec

The authoritative behavioral contract lives in [compat/](compat/). Every public
behavior has a stable rule ID (`R-EXEC-09`, `R-COP-15`, …) referenced from
tests. Start with [compat/overview.md](compat/overview.md) and the porting
[ROADMAP](compat/ROADMAP.md).
