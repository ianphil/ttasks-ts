# Finally tasks

Finally tasks are graph-scheduling semantics for work that should run after one
or more upstream tasks become **inactive**. They are useful for cleanup,
reporting, artifact collection, and recommendations.

They are not JavaScript `finally` blocks, and they are not graph-level retry.
They are regular tasks with special readiness rules inside `TaskGraph`.

## Basic form

```ts
import { Task, TaskGraph } from '@ianphil/ttasks-ts';

const lint   = Task.bash('eslint .',                { title: 'Lint' });
const test   = Task.bash('vitest run',              { title: 'Tests' });
const report = Task.bash('node scripts/report.js',  { title: 'Write report' });

const graph = new TaskGraph({ title: 'preflight' });
graph.add(lint);
graph.add(test);
graph.add(report, { after: [lint, test], finally_: true });
```

The finally task becomes ready once every listed `after` task is no longer
active, even if one failed, was cancelled, or became blocked.

## Cleanup after failed work

Use a required finally task for cleanup that must succeed for the graph to be
healthy.

```ts
const build   = Task.bash('make build',          { title: 'Build' });
const cleanup = Task.bash('rm -rf .tmp-build',   { title: 'Clean temp files' });

graph.add(build);
graph.add(cleanup, { after: [build], finally_: true });
```

If `build` fails, `cleanup` still runs. If `cleanup` fails, it is a required
task by default, so `graph.ok` is false.

## Reports and artifacts

A finally task receives the listed `after` tasks through `ctx.upstream`, just
like a normal dependency. Use that to summarize results or collect artifact
paths.

```ts
exec.register(TaskType.BASH, (ctx) => {
  const lines: string[] = [];
  for (const upstream of ctx.upstream.values()) {
    lines.push(`${upstream.title}: ${upstream.status}`);
    if (upstream.result?.error) lines.push(upstream.result.error);
  }
  return lines.join('\n');
});
```

## Optional recommendations

Pass `required: false` for best-effort reporting, artifact collection, or
Copilot recommendation tasks. Their failures are visible, but they do not make
`graph.ok` false by themselves.

```ts
const recommend = Task.prompt(
  'Summarize preflight output and recommend the next action.',
  { title: 'Copilot recommendation' },
);

graph.add(recommend, {
  after: [lint, test, report],
  finally_: true,
  required: false,
});
```

> Note: `required: false` is only valid when `finally_: true`.

## Required vs optional

| Setting | Failure effect | Good use |
| --- | --- | --- |
| `required: true` (default) | Failure makes `graph.ok` false | Cleanup that must complete |
| `required: false` | Failure is reported but does not make `graph.ok` false | Reports, artifact collection, AI recommendations |

Required and optional finally tasks are available through introspection views:

- `graph.finallyTasks`
- `graph.optionalTasks`
- `graph.requiredTasks`
- `graph.optionalFailed`
- `graph.requiredFailed`
- `graph.requiredBlocked`

`graph.ok` remains the authoritative success predicate.
