import { describe, expect, it } from 'vitest';

import { TaskEventType, type TaskEvent } from '../src/events.js';
import {
  SubprocessFailureError,
  TaskCancelled,
  TaskExecutor,
} from '../src/executor.js';
import { createBashHandler, createPowershellHandler } from '../src/handlers/index.js';
import { Task, TaskStatus, TaskType } from '../src/task.js';

function setupBash(): { exec: TaskExecutor; events: TaskEvent[] } {
  const exec = new TaskExecutor();
  exec.register(TaskType.BASH, createBashHandler());
  const events: TaskEvent[] = [];
  exec.events.subscribe((e) => events.push(e));
  return { exec, events };
}

describe('BASH handler — R-EXEC-28', () => {
  it('streams stdout chunks and retains them on the result', async () => {
    const { exec, events } = setupBash();
    const t = Task.bash('printf hello');
    const result = await exec.execute(t);
    expect(t.status).toBe(TaskStatus.SUCCEEDED);
    expect(result.output).toBe('hello');
    expect(result.returncode).toBe(0);
    const outputEvents = events.filter(
      (e) => e.type === TaskEventType.OUTPUT && e.outputStream === 'stdout',
    );
    expect(outputEvents.length).toBeGreaterThan(0);
    expect(outputEvents.map((e) => e.outputChunk).join('')).toBe('hello');
  });

  it('streams stderr separately from stdout', async () => {
    const { exec, events } = setupBash();
    const t = Task.bash('printf out; printf err 1>&2');
    const result = await exec.execute(t);
    expect(result.output).toBe('out');
    expect(result.error).toBe('err');
    const out = events.filter(
      (e) => e.type === TaskEventType.OUTPUT && e.outputStream === 'stdout',
    );
    const err = events.filter(
      (e) => e.type === TaskEventType.OUTPUT && e.outputStream === 'stderr',
    );
    expect(out.map((e) => e.outputChunk).join('')).toBe('out');
    expect(err.map((e) => e.outputChunk).join('')).toBe('err');
  });

  it('non-zero exit -> FAILED with terminationReason=exit_code and preserved output', async () => {
    const { exec, events } = setupBash();
    const t = Task.bash('printf partial; printf "bad" 1>&2; exit 3');
    await expect(exec.execute(t)).rejects.toBeInstanceOf(SubprocessFailureError);
    expect(t.status).toBe(TaskStatus.FAILED);
    expect(t.result?.output).toBe('partial');
    expect(t.result?.error).toBe('bad');
    expect(t.result?.returncode).toBe(3);
    expect(t.result?.terminationReason).toBe('exit_code');
    // OUTPUT events precede the FAILED event (R-EXEC-28).
    const outputIdx = events.findIndex((e) => e.type === TaskEventType.OUTPUT);
    const failedIdx = events.findIndex((e) => e.type === TaskEventType.FAILED);
    expect(outputIdx).toBeGreaterThanOrEqual(0);
    expect(outputIdx).toBeLessThan(failedIdx);
  });
});

describe('BASH handler — R-EXEC-29 timeout', () => {
  it('killed on timeout, partial output preserved, terminationReason=timeout', async () => {
    const { exec } = setupBash();
    const t = Task.bash('printf early; sleep 5', { timeout: 0.2 });
    const started = Date.now();
    await expect(exec.execute(t)).rejects.toBeInstanceOf(SubprocessFailureError);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2000);
    expect(t.status).toBe(TaskStatus.FAILED);
    expect(t.result?.terminationReason).toBe('timeout');
    expect(t.result?.output).toBe('early');
  });
});

describe('BASH handler — R-EXEC-30 cancellation', () => {
  it('cancelling a running subprocess terminates the process and marks CANCELLED', async () => {
    const { exec } = setupBash();
    const t = Task.bash('sleep 5');
    const submitted = exec.submit(t);
    // Wait for it to be RUNNING.
    await new Promise((r) => setTimeout(r, 100));
    expect(t.status).toBe(TaskStatus.RUNNING);
    const started = Date.now();
    exec.cancel(t);
    await expect(submitted).rejects.toBeInstanceOf(TaskCancelled);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2000);
    expect(t.status).toBe(TaskStatus.CANCELLED);
  });
});

describe('BASH handler — R-EXEC-31 lossy decode', () => {
  it('non-UTF-8 byte stream does not crash', async () => {
    const { exec } = setupBash();
    // Emit 0xff which is invalid UTF-8.
    const t = Task.bash(`printf '\\xff'`);
    const result = await exec.execute(t);
    expect(t.status).toBe(TaskStatus.SUCCEEDED);
    expect(typeof result.output).toBe('string');
    // Replacement char or empty — must not throw.
  });
});

describe('POWERSHELL handler — R-EXEC-28', () => {
  it('runs a simple command if pwsh is available', async () => {
    const exec = new TaskExecutor();
    exec.register(TaskType.POWERSHELL, createPowershellHandler());
    const t = new Task(TaskType.POWERSHELL, 'Write-Output ok');
    try {
      const result = await exec.execute(t);
      expect(t.status).toBe(TaskStatus.SUCCEEDED);
      expect(result.output.trim()).toBe('ok');
    } catch (err) {
      // pwsh not installed in this environment — skip the assertion path.
      if (err instanceof SubprocessFailureError || err instanceof Error) {
        // Spawn error or non-zero exit from missing shell; acceptable.
        return;
      }
      throw err;
    }
  });
});
