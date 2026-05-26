# Retries and cancellation

## Single-task retries

Single-task retries are opt-in with `RetryPolicy`.

```ts
import { RetryPolicy, Task, TaskExecutor } from 'ttasks-ts';

const executor = new TaskExecutor();
const task = Task.bash('./flaky-command', { title: 'Flaky command' });

const result = await executor.execute(task, {
  retryPolicy: new RetryPolicy({ maxAttempts: 3, backoff: 0.5 }),
});
```

`maxAttempts` is the total attempt count, including the first run. `backoff` is
the number of seconds to sleep between failed attempts.

Retries apply to single-task `execute()` and `submit()` calls. Graph-level
retry is not provided by this policy.

Each attempt emits its normal lifecycle events, and `task.result` reflects only
the final attempt.

## Cancellation is not retried

Cancellation is terminal for retry policy purposes. Handlers may cooperatively
abort by throwing `TaskCancelled`; the executor owns the transition to
`CANCELLED` and records the terminal `TaskResult`.

Cancel a task through the executor to also terminate any active subprocess:

```ts
executor.cancel(task);
```

Inside a handler, prefer `ctx.signal` (an `AbortSignal`) or
`ctx.raiseIfCancelled()`:

```ts
executor.register(TaskType.BASH, async (ctx) => {
  for (let i = 0; i < 10; i++) {
    ctx.raiseIfCancelled();
    await doStep(i, { signal: ctx.signal });
  }
});
```

`AbortSignal` interoperates with `fetch`, `setTimeout`, `node:stream`, and most
modern Node APIs, so handlers can pass `ctx.signal` straight through.

## Timeouts

`Task.timeout` defaults to `undefined`, which means no automatic timeout is
applied.

```ts
Task.bash('sleep 30', { title: 'Long task' });
```

Use a positive timeout (seconds) for bounded subprocess execution:

```ts
Task.bash('sleep 30', { title: 'Bounded task', timeout: 5 });
```

If the timeout is exceeded, the executor aborts `ctx.signal`, terminates the
subprocess, marks the task failed, stores the timeout message in `task.error`,
attaches a failed `TaskResult`, and throws `TaskTimeoutError`.
