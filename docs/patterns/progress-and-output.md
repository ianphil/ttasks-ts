# Progress and output

Every executor has an `EventBus` for task lifecycle events.

```ts
import { TaskEvent, TaskEventType } from '@ianphil/ttasks-ts';

const seen: TaskEvent[] = [];
await executor.events.subscribeScoped(
  (event) => seen.push(event),
  async () => { await executor.execute(task); },
);

console.log(seen.map((e) => e.type));
// [TaskEventType.STARTED, TaskEventType.SUCCEEDED]
```

For long-lived subscribers, use `executor.events.subscribe(callback)`, which
returns an idempotent unsubscribe callable.

## Event payloads

Events include:

- `type`: `STARTED`, `PROGRESS`, `OUTPUT`, `SUCCEEDED`, `FAILED`, `CANCELLED`,
  `BLOCKED`, or `PERSISTENCE_FAILED`
- `taskId`
- `task`
- `previousStatus`
- `status`
- `timestamp`
- `error`, when relevant
- `progressPercent` and `progressMessage`, when `type` is `PROGRESS`
- `outputStream` and `outputChunk`, when `type` is `OUTPUT`

Subscriber exceptions do not fail task execution. They are recorded on
`executor.events.errors` so observers cannot break the work they observe.

## Progress events

Handlers can report progress without changing task lifecycle state:

```ts
executor.register(TaskType.BASH, async (ctx) => {
  ctx.emitProgress(25, 'warming up');
  ctx.emitProgress(undefined, 'still working');
  return 'done';
});
```

Progress percentages are optional finite values from 0 through 100. They are
not required to be monotonic.

## Streaming subprocess output

Built-in subprocess handlers emit `OUTPUT` events as stdout and stderr chunks
are read. Complete stdout and stderr are still retained on the terminal
`TaskResult`.

```ts
executor.events.subscribe((event) => {
  if (event.type === TaskEventType.OUTPUT) {
    process[event.outputStream === 'stderr' ? 'stderr' : 'stdout']
      .write(event.outputChunk ?? '');
  }
});
```

Output subscribers run synchronously when chunks arrive, so keep callbacks fast.
