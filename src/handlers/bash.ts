import type { TaskHandler } from '../executor.js';

import { runShell, type ShellCompletion } from './subprocess.js';

export interface BashHandlerOptions {
  bashPath?: string;
}

// R-EXEC-28: built-in BASH handler. Invokes `bash -c <payload>`.
export function createBashHandler(options: BashHandlerOptions = {}): TaskHandler {
  const bashPath = options.bashPath ?? 'bash';
  return async (ctx): Promise<ShellCompletion> => {
    return runShell({
      command: bashPath,
      args: ['-c', ctx.payload],
      ctx,
    });
  };
}
