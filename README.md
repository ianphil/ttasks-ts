# ttasks-ts

A small, dependency-light TypeScript library for running **tasks**, **DAG workflows**, and **Copilot agent sessions** with cancellation, retries, events, and durable persistence.

TypeScript port of [`ttasks`](https://github.com/ianphil/ttasks). Built for Node.js 24+ (uses the stable built-in `node:sqlite`).

## Install

```bash
pnpm add ttasks-ts
```

Requires Node.js **≥ 24**.

## Hello world

```ts
import { Task, TaskExecutor, TaskGraph, TaskType, SqliteStore, createBashHandler } from 'ttasks-ts';

const store = new SqliteStore({ path: 'tasks.db' });
const exec = new TaskExecutor({ store });
exec.register(TaskType.BASH, createBashHandler());

const hello  = Task.bash('echo hello',         { title: 'hello' });
const world  = Task.bash('echo world',         { title: 'world' });
const greet  = Task.bash('echo "hello world!"',{ title: 'greet' });

const g = new TaskGraph({ title: 'hello-world' });
g.add(hello);
g.add(world, { after: [hello] });
g.add(greet, { after: [hello, world] });

await g.run(exec);
console.log(greet.result!.output.trim()); // "hello world!"
```

## Features

- **Tasks** with status machine, retries, timeouts, cancellation (`AbortSignal`)
- **Graphs** (DAGs) with parallel scheduling, `finally` tasks, optional tasks, fail-fast / continue-on-error
- **Events** — subscribe to lifecycle, progress, and output streams
- **Stores** — `InMemoryStore` and durable `SqliteStore` (versioned schema, atomic graph save)
- **Built-in handlers** — `bash` and `powershell` subprocess runners
- **Copilot integration** — `makeCopilotPromptHandler`, `makeCopilotAgentHandler`, long-lived `CopilotAgentSession` with turn serialization, behind a swappable `CopilotProvider` interface

## Copilot quick taste

```ts
import { CopilotAgentSession, makeCopilotPromptHandler, TaskType, Task, TaskExecutor } from 'ttasks-ts';

// One-shot prompt
const exec = new TaskExecutor();
exec.register(TaskType.PROMPT, makeCopilotPromptHandler({ provider }));
await exec.execute(Task.prompt('Summarize this PR'));

// Multi-turn agent session
const session = new CopilotAgentSession({ provider, model: 'gpt-5' });
await session.open();
exec.register(TaskType.AGENT, session.handler());
// ... run AGENT tasks; turns are serialized on the same session
await session.close();
```

Ship your own `CopilotProvider`; a `StubCopilotProvider` is included for tests.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test       # 247 tests
pnpm build
```

## Status

All porting phases complete. See [`docs/ROADMAP.md`](./docs/ROADMAP.md) and the rule-level specs in [`docs/compat/`](./docs/compat/) for the authoritative behavioral contract.

## License

MIT

