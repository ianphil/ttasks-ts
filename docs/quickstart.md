# Quickstart

## Run one task

```ts
import { Task, TaskExecutor, TaskType } from 'ttasks-ts';
import { createBashHandler } from 'ttasks-ts';

const executor = new TaskExecutor();
executor.register(TaskType.BASH, createBashHandler());

const task = Task.bash('echo hello', { title: 'Say hello' });
const result = await executor.execute(task);

console.log(task.status); // 'succeeded'
console.log(result.output.trim()); // 'hello'
console.log(task.result === result); // true
```

`TaskExecutor` has no built-in handlers — register the ones you need with
`executor.register(TaskType.X, handler)`. Built-in handler factories include
`createBashHandler()`, `createPowerShellHandler()`, `makeCopilotPromptHandler()`,
and `makeCopilotAgentHandler()`.

## Subscribe to events

Every executor exposes an `EventBus` for lifecycle, progress, and output events.
`subscribe(...)` returns an idempotent unsubscribe callable.

```ts
import { TaskEvent, TaskExecutor } from 'ttasks-ts';

const executor = new TaskExecutor();
const unsubscribe = executor.events.subscribe((event: TaskEvent) => {
  console.log(`${event.type}: ${event.task.title} -> ${event.status}`);
});
try {
  await executor.execute(Task.bash('echo hello', { title: 'Say hello' }));
} finally {
  unsubscribe();
}
```

For scoped subscriptions in tests or short blocks, use
`events.subscribeScoped(handler, () => promise)`. See
[Progress and output](patterns/progress-and-output.md) for the event payload
shape and streamed subprocess output.

## Share a Copilot agent session

The one-shot agent handler created by `makeCopilotAgentHandler` opens and closes
a Copilot session for every task. Use `CopilotAgentSession` when multiple
`Task.agent(...)` tasks should share one conversation:

```ts
import {
  CopilotAgentSession,
  Task,
  TaskExecutor,
  TaskType,
} from 'ttasks-ts';

const session = new CopilotAgentSession({
  provider,
  model: 'gpt-5',
  workingDirectory: '/path/to/repo',
});
await session.open();
try {
  const executor = new TaskExecutor();
  executor.register(TaskType.AGENT, session.handler());

  await executor.execute(Task.agent('Create a first change.'));
  await executor.execute(Task.agent('Continue from the previous change.'));
} finally {
  await session.close();
}
```

Shared sessions preserve conversation state across agent tasks. The handler
serializes turns through the session, including when used by `TaskGraph`. See
the [Copilot tutorial](tutorials/copilot.md).

## Run a graph

```ts
import { Task, TaskExecutor, TaskGraph, TaskType } from 'ttasks-ts';
import { createBashHandler } from 'ttasks-ts';

const build   = Task.bash('echo build',   { title: 'Build' });
const test    = Task.bash('echo test',    { title: 'Test' });
const pack    = Task.bash('echo package', { title: 'Package' });

const graph = new TaskGraph({ title: 'build pipeline' });
graph.add(build);
graph.add(test, { after: [build] });
graph.add(pack, { after: [test] });

const exec = new TaskExecutor();
exec.register(TaskType.BASH, createBashHandler());
await graph.run(exec);

console.log(graph.ok); // true
console.log(graph.succeeded.map(t => t.title)); // ['Build', 'Test', 'Package']
```

If a task fails or is cancelled, downstream tasks are marked blocked and are not
submitted. Use [finally tasks](patterns/finally-tasks.md) for cleanup and
reporting work that should still run after failure.

## Persist tasks and graphs

Use `InMemoryStore` for tests or short-lived programs. Use `SqliteStore` when
you want task and graph state to survive process restarts. `SqliteStore` is
backed by Node 24's built-in `node:sqlite`, so there are no native deps.

```ts
import {
  InMemoryStore,
  SqliteStore,
  Task,
  TaskExecutor,
  TaskGraph,
  TaskType,
} from 'ttasks-ts';
import { createBashHandler } from 'ttasks-ts';

const store = new SqliteStore({ path: 'ttasks.db' });
const exec = new TaskExecutor({ store });
exec.register(TaskType.BASH, createBashHandler());

const build = Task.bash('echo build', { title: 'Build' });
const test  = Task.bash('echo test',  { title: 'Test' });

const graph = new TaskGraph({ title: 'stored pipeline' });
graph.add(build);
graph.add(test, { after: [build] });
await graph.run(exec);

console.log(store.tasks.get(build.id)?.status === build.status); // true
console.log(store.graphs.get(graph.id)?.ok === true);            // true

store.close();
```

When an executor has a store, it saves tasks on lifecycle transitions and saves
graphs when `TaskGraph.run(...)` completes. `SqliteStore` reads return detached
snapshots, so call `save()` again if you mutate them after loading.
