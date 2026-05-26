# Copilot

ttasks-ts treats Copilot integration as a swappable provider, not a hard
dependency. You implement (or import) a `CopilotProvider`, and the library
gives you two handler factories and one long-lived session class on top of it.

## The provider seam

```ts
import type { CopilotProvider } from '@ianphil/ttasks-ts';

const provider: CopilotProvider = {
  async createSession(opts) {
    // opts.model, opts.tools, opts.reasoningEffort, opts.workingDirectory,
    // opts.sessionOptions, opts.onEvent
    return {
      async sendAndWait(prompt, sendOpts) { /* call your SDK */ return '...'; },
      async abort() { /* optional: cancel in-flight request */ },
      async close() { /* tear down */ },
    };
  },
};
```

A `StubCopilotProvider` is exported for unit tests. It records calls, lets
you configure a responder, and honors `AbortSignal`.

## One-shot prompts (`Task.prompt`)

`makeCopilotPromptHandler` opens a session with `tools: false`, sends one turn,
and closes the session. Default model is `gpt-5-mini`, default timeout is 60s.

```ts
import { Task, TaskExecutor, TaskType, makeCopilotPromptHandler } from '@ianphil/ttasks-ts';

const exec = new TaskExecutor();
exec.register(TaskType.PROMPT, makeCopilotPromptHandler({ provider }));

const result = await exec.execute(Task.prompt('Summarize this PR.'));
console.log(result.output);
```

## One-shot agent turns (`Task.agent`)

`makeCopilotAgentHandler` opens a session with `tools: true`, sends one turn,
closes the session. Default model is `gpt-5`, no default timeout.

```ts
import { makeCopilotAgentHandler } from '@ianphil/ttasks-ts';
exec.register(TaskType.AGENT, makeCopilotAgentHandler({ provider }));

await exec.execute(Task.agent('Run the test suite and report results.'));
```

## Shared multi-turn sessions

When several `Task.agent(...)` tasks should share one conversation, use
`CopilotAgentSession`:

```ts
import { CopilotAgentSession, Task, TaskExecutor, TaskType } from '@ianphil/ttasks-ts';

const session = new CopilotAgentSession({
  provider,
  model: 'gpt-5',
  workingDirectory: '/path/to/repo',
  // timeout: 120,
});
await session.open();
try {
  const exec = new TaskExecutor();
  exec.register(TaskType.AGENT, session.handler());

  await exec.execute(Task.agent('Create a first change.'));
  await exec.execute(Task.agent('Continue from the previous change.'));
} finally {
  await session.close();
}
```

Properties of a shared session:

- One underlying provider session reused across turns (`open` → many turns → `close`).
- Turns are **serialized** in submission order, even when fired concurrently or
  via a `TaskGraph`.
- Cancelling a task (via `AbortSignal`) calls `session.abort()` on the provider
  and rejects the in-flight turn with `TaskCancelled`. The session remains
  usable for the next turn.
- `session.on(handler)` subscribes to provider events; subscriber errors are
  captured in `session.eventErrors` and isolated so they don't break the turn.
- `session.handler()` returns a `TaskHandler` you can register on a
  `TaskExecutor` or pass via `TaskGraph`.

## Defaults

| Factory | Default model | Default timeout |
| --- | --- | --- |
| `makeCopilotPromptHandler` | `gpt-5-mini` | `60` seconds |
| `makeCopilotAgentHandler` | `gpt-5` | none |
| `new CopilotAgentSession` | required | none |

Per-task `timeout` overrides the factory/session default. Pass `timeout: null`
to opt out entirely.

## Notes for TypeScript

The Python library exposes both sync and async entry points. The TypeScript
port collapses these into a single async surface and uses native `AbortSignal`
for cancellation. See `docs/compat/copilot.md` §"TypeScript port guidance" for
the rule-level deltas.
