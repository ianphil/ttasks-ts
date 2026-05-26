# Task execution

## Tasks and results

A `Task` is the unit of work tracked by ttasks-ts.

```ts
import { Task } from '@ianphil/ttasks-ts';

const task = Task.bash('ls -la', {
  title: 'List files',
  description: 'Show files in the current directory',
});
```

Convenience factories create the corresponding task type without making callers
import `TaskType`:

- `Task.bash()`
- `Task.powershell()`
- `Task.prompt()`
- `Task.agent()`

Every terminal execution path attaches a `TaskResult` to `task.result`.

```ts
const result = await executor.execute(task);

console.log(result.status);
console.log(result.output);
console.log(result.error);
console.log(result.returncode);
console.log(result.startedAt);
console.log(result.finishedAt);
console.log(result.duration);
```

For subprocess tasks, `TaskResult.raw` is the underlying shell completion
object (`{ stdout, stderr, returncode }`). `TaskResult.output` is the captured
stdout string.

## Executor handlers

`TaskExecutor` dispatches tasks to handlers registered by `TaskType`. Unlike
the Python library, no handlers are pre-registered — wire up only what you need.

```ts
import { TaskExecutor, TaskType } from '@ianphil/ttasks-ts';

const executor = new TaskExecutor();
executor.register(TaskType.BASH, (ctx) => 'handled');
```

Handler contract:

- returning a value (or a `Promise` that resolves) means success
- throwing `TaskCancelled` means cancellation
- throwing any other error means failure
- handlers should not mutate lifecycle state directly
- `ctx.upstream` exposes direct upstream task refs keyed by task ID
- `ctx.emitProgress(percent, message)` emits progress events for observers
- `ctx.signal` is an `AbortSignal` that fires on cancellation or timeout
- `ctx.raiseIfCancelled()` is a one-line check that throws `TaskCancelled`

For single-task execution, upstream refs can be passed manually:

```ts
await executor.execute(child, { upstream: new Map([[parent.id, parent]]) });
```

## Prompt and agent tasks

Prompt tasks send `Task.payload` to Copilot and store the assistant message text
in `TaskResult.output`.

```ts
import { Task, TaskExecutor, TaskType, makeCopilotPromptHandler } from '@ianphil/ttasks-ts';

const executor = new TaskExecutor();
executor.register(TaskType.PROMPT, makeCopilotPromptHandler({ provider }));

const task = Task.prompt('Explain a DAG in one concise sentence.', {
  title: 'Explain DAGs',
});

const result = await executor.execute(task);
console.log(result.output);
```

Agent tasks send `Task.payload` to Copilot with the SDK's default tools enabled.
Treat agent task payloads as trusted executable instructions, similar to Bash
payloads. See the [Copilot tutorial](./copilot.md) for shared sessions.

## Persistence

A `Store` is the seam between live runtime objects and durable backends. It
exposes two collections keyed by object ID:

- `store.tasks`
- `store.graphs`

```ts
import { InMemoryStore, Task, TaskGraph } from '@ianphil/ttasks-ts';

const store = new InMemoryStore();
const task = Task.bash('echo hi', { title: 'hello' });
store.tasks.save(task);
console.log(store.tasks.get(task.id) === task); // true

const graph = new TaskGraph({ title: 'build' });
graph.add(task);
store.graphs.save(graph);
console.log(store.graphs.has(graph.id)); // true
```

`SqliteStore` provides the same surface using a SQLite file. Reads return
detached snapshots, so call `save()` again after later changes.

When `TaskExecutor` is constructed with a store, it auto-saves the task on every
lifecycle transition before emitting the corresponding event.
