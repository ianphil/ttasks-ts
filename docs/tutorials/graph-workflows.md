# Graph workflows

`TaskGraph` runs tasks as a directed acyclic graph. Dependencies must be
registered in the graph before `run()`.

```ts
import { Task, TaskExecutor, TaskGraph, TaskType } from '@ianphil/ttasks-ts';
import { createBashHandler } from '@ianphil/ttasks-ts';

const build = Task.bash('echo build', { title: 'Build' });
const test  = Task.bash('echo test',  { title: 'Test' });
const pack  = Task.bash('echo package', { title: 'Package' });

const graph = new TaskGraph({ title: 'build pipeline' });
graph.add(build);
graph.add(test, { after: [build] });
graph.add(pack, { after: [test] });

const exec = new TaskExecutor();
exec.register(TaskType.BASH, createBashHandler());
await graph.run(exec);
```

## Reading outcomes

Useful graph views include:

- `graph.succeeded`
- `graph.failed`
- `graph.cancelled`
- `graph.blocked`
- `graph.finallyTasks`
- `graph.optionalTasks`
- `graph.requiredTasks`
- `graph.optionalFailed`
- `graph.requiredFailed`
- `graph.requiredBlocked`
- `graph.errors`
- `graph.roots()`
- `graph.leaves()`

`graph.ok` is the authoritative success predicate. Optional finally-task
failures are visible through outcome views without making `graph.ok` false.

## Failure behavior

If a task fails or is cancelled, downstream tasks are blocked and not submitted.
Executor or setup errors raised by submitted work are available in
`graph.errors`, keyed by task ID.

Already-succeeded tasks count as satisfied dependencies, so a graph can be
rerun or extended after partial completion.

## Upstream context

When a graph submits a task, its handler receives direct dependency task refs in
`ctx.upstream`. The refs come from the graph itself and are keyed by task ID:

```ts
exec.register(TaskType.BASH, (ctx) => {
  const parent = ctx.upstream.get(build.id);
  if (parent?.result == null) throw new Error('expected parent result');
  return parent.result.output.toUpperCase();
});
```

Only direct dependencies are included. If a task needs an earlier ancestor, add
that ancestor as an explicit graph dependency.

## Finally tasks

Use [finally tasks](../patterns/finally-tasks.md) for cleanup, reporting, and
artifact collection work that should run after dependencies are inactive even
if they failed or were blocked.
