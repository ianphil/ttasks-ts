# API reference

The API reference is generated from TSDoc comments with
[TypeDoc](https://typedoc.org/).

```bash
pnpm docs
```

Output is written to `docs/api/` (gitignored). Open `docs/api/index.html` in
a browser.

To regenerate as part of CI or a release, run `pnpm docs` after `pnpm build`.

## What's documented

TypeDoc walks the public entry point `src/index.ts`, which re-exports:

- `task.ts` — `Task`, `TaskType`, `TaskStatus`, `TaskResult`, factories
- `executor.ts` — `TaskExecutor`, `TaskContext`, `RetryPolicy`, errors
- `graph.ts` — `TaskGraph`, outcome views, `TaskGraphSnapshot`
- `events.ts` — `EventBus`, `TaskEvent`, `TaskEventType`
- `store.ts` — `Store`, `InMemoryStore`, store interfaces
- `store-sqlite.ts` — `SqliteStore`
- `handlers/index.ts` — `createBashHandler`, `createPowerShellHandler`
- `copilot/index.ts` — `makeCopilotPromptHandler`, `makeCopilotAgentHandler`,
  `CopilotAgentSession`, `StubCopilotProvider`, provider interfaces
