// Shared subprocess runner powering the built-in BASH and POWERSHELL
// handlers. R-EXEC-28..31 + R-EVT-14.

import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import {
  SubprocessFailureError,
  TaskCancelled,
  type TaskContext,
} from '../executor.js';

/** @category Handlers */
export interface RunShellOptions {
  command: string;
  args: ReadonlyArray<string>;
  ctx: TaskContext;
  killGraceMs?: number;
}

const DEFAULT_KILL_GRACE_MS = 100;

/** @category Handlers */
export interface ShellCompletion {
  stdout: string;
  stderr: string;
  returncode: number;
}

/** @category Handlers */
export async function runShell(options: RunShellOptions): Promise<ShellCompletion> {
  const { command, args, ctx } = options;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  if (ctx.cancelled) {
    throw new TaskCancelled();
  }

  let child: ChildProcess;
  try {
    child = spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
  const stdout = child.stdout as Readable;
  const stderr = child.stderr as Readable;

  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  let stdoutCollected = '';
  let stderrCollected = '';

  stdout.on('data', (buf: Buffer) => {
    const chunk = stdoutDecoder.write(buf);
    if (chunk.length === 0) return;
    stdoutCollected += chunk;
    try {
      ctx.emitOutput('stdout', chunk);
    } catch {
      /* ignore */
    }
  });
  stderr.on('data', (buf: Buffer) => {
    const chunk = stderrDecoder.write(buf);
    if (chunk.length === 0) return;
    stderrCollected += chunk;
    try {
      ctx.emitOutput('stderr', chunk);
    } catch {
      /* ignore */
    }
  });

  let timedOut = false;
  let cancelled = false;
  let killTimer: NodeJS.Timeout | undefined;
  let escalationTimer: NodeJS.Timeout | undefined;

  const killProcess = (signal: NodeJS.Signals = 'SIGTERM'): void => {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    } catch {
      /* already exited */
    }
  };

  const onAbort = (): void => {
    if (cancelled) return;
    cancelled = true;
    killProcess('SIGTERM');
    escalationTimer = setTimeout(() => killProcess('SIGKILL'), killGraceMs);
  };
  if (ctx.signal.aborted) {
    onAbort();
  } else {
    ctx.signal.addEventListener('abort', onAbort, { once: true });
  }

  const timeoutSec = ctx.timeout;
  if (typeof timeoutSec === 'number' && timeoutSec > 0) {
    killTimer = setTimeout(() => {
      timedOut = true;
      killProcess('SIGTERM');
      escalationTimer = setTimeout(() => killProcess('SIGKILL'), killGraceMs);
    }, timeoutSec * 1000);
  }

  try {
    const { code, signal } = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once('error', (err) => reject(err));
      child.once('close', (c, s) => resolve({ code: c, signal: s }));
    });

    const tailOut = stdoutDecoder.end();
    if (tailOut.length > 0) {
      stdoutCollected += tailOut;
      try {
        ctx.emitOutput('stdout', tailOut);
      } catch {
        /* ignore */
      }
    }
    const tailErr = stderrDecoder.end();
    if (tailErr.length > 0) {
      stderrCollected += tailErr;
      try {
        ctx.emitOutput('stderr', tailErr);
      } catch {
        /* ignore */
      }
    }

    if (cancelled) {
      throw new TaskCancelled();
    }

    if (timedOut) {
      throw new SubprocessFailureError(
        `Task exceeded timeout of ${String(timeoutSec)}s`,
        { stdout: stdoutCollected, stderr: stderrCollected, returncode: code ?? -1 },
        'timeout',
      );
    }

    const returncode = code ?? (signal !== null ? 128 : -1);
    if (returncode !== 0) {
      const message =
        stderrCollected.trim().length > 0
          ? stderrCollected.trim()
          : `Process exited with code ${String(returncode)}`;
      throw new SubprocessFailureError(
        message,
        { stdout: stdoutCollected, stderr: stderrCollected, returncode },
        'exit_code',
      );
    }

    return { stdout: stdoutCollected, stderr: stderrCollected, returncode };
  } finally {
    if (killTimer !== undefined) clearTimeout(killTimer);
    if (escalationTimer !== undefined) clearTimeout(escalationTimer);
    ctx.signal.removeEventListener('abort', onAbort);
  }
}
