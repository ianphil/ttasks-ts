import { describe, expect, it } from 'vitest';

import { Task, TaskStatus, TaskType } from '../src/index.js';

describe('Task factories (R-TASK-11)', () => {
  it('R-TASK-10 / R-TASK-11 bash factory sets type and payload', () => {
    const t = Task.bash('echo hi');
    expect(t.type).toBe(TaskType.BASH);
    expect(t.payload).toBe('echo hi');
    expect(t.status).toBe(TaskStatus.PENDING);
  });

  it('R-TASK-10 / R-TASK-11 powershell factory sets type and payload', () => {
    const t = Task.powershell('Write-Host hi');
    expect(t.type).toBe(TaskType.POWERSHELL);
    expect(t.payload).toBe('Write-Host hi');
  });

  it('R-TASK-10 / R-TASK-11 prompt factory sets type and payload', () => {
    const t = Task.prompt('hello');
    expect(t.type).toBe(TaskType.PROMPT);
    expect(t.payload).toBe('hello');
  });

  it('R-TASK-10 / R-TASK-11 agent factory sets type and payload', () => {
    const t = Task.agent('do thing');
    expect(t.type).toBe(TaskType.AGENT);
    expect(t.payload).toBe('do thing');
  });

  it('R-TASK-11 factories accept title, description, and timeout', () => {
    const t = Task.bash('echo hi', {
      title: 'T',
      description: 'D',
      timeout: 7,
    });
    expect(t.title).toBe('T');
    expect(t.description).toBe('D');
    expect(t.timeout).toBe(7);
  });

  it('R-TASK-02 + R-TASK-11 factory timeout validation still applies', () => {
    expect(() => Task.bash('echo hi', { timeout: 0 })).toThrow();
    expect(() => Task.powershell('x', { timeout: -1 })).toThrow();
    expect(() => Task.prompt('x', { timeout: -0.001 })).toThrow();
    expect(() => Task.agent('x', { timeout: 0 })).toThrow();
  });

  it('R-TASK-05 factory-built tasks have distinct ids', () => {
    const a = Task.bash('a');
    const b = Task.bash('a');
    expect(a.id).not.toBe(b.id);
  });
});
