# ttasks-ts

TypeScript port of [`ttasks`](https://github.com/ianphil/ttasks).

## Status

Project scaffold only for now. The next step is to port the Python behavior into
TypeScript while using the Python test suite as a semantic reference.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

## Initial module plan

- `src/task.ts` — task domain model and status machine
- `src/events.ts` — event bus and task events
- `src/executor.ts` — task execution, retries, cancellation, subprocesses
- `src/graph.ts` — DAG workflows and finally tasks
- `src/store.ts` — in-memory and SQLite-backed persistence
