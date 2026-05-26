import type { TaskHandler } from '../executor.js';

import { runShell, type ShellCompletion } from './subprocess.js';

export interface PowershellHandlerOptions {
  pwshPath?: string;
}

// R-EXEC-28: built-in POWERSHELL handler. Invokes `pwsh -NoProfile -Command <payload>`.
export function createPowershellHandler(
  options: PowershellHandlerOptions = {},
): TaskHandler {
  const pwshPath = options.pwshPath ?? 'pwsh';
  return async (ctx): Promise<ShellCompletion> => {
    return runShell({
      command: pwshPath,
      args: ['-NoProfile', '-Command', ctx.payload],
      ctx,
    });
  };
}
