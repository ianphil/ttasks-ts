import { describe, expect, it } from 'vitest';

import { RetryPolicy } from '../src/executor.js';

describe('RetryPolicy', () => {
  it('R-EXEC-16: rejects non-integer maxAttempts', () => {
    expect(() => new RetryPolicy({ maxAttempts: 1.5 })).toThrow(TypeError);
    expect(() => new RetryPolicy({ maxAttempts: Number.NaN })).toThrow(TypeError);
  });

  it('R-EXEC-16: rejects maxAttempts < 1', () => {
    expect(() => new RetryPolicy({ maxAttempts: 0 })).toThrow(RangeError);
    expect(() => new RetryPolicy({ maxAttempts: -3 })).toThrow(RangeError);
  });

  it('R-EXEC-16: rejects non-finite backoff', () => {
    expect(() => new RetryPolicy({ maxAttempts: 1, backoff: Number.POSITIVE_INFINITY })).toThrow(
      TypeError,
    );
    expect(() => new RetryPolicy({ maxAttempts: 1, backoff: Number.NaN })).toThrow(TypeError);
  });

  it('R-EXEC-16: rejects negative backoff', () => {
    expect(() => new RetryPolicy({ maxAttempts: 1, backoff: -0.1 })).toThrow(RangeError);
  });

  it('defaults backoff to 0 and is frozen', () => {
    const p = new RetryPolicy({ maxAttempts: 3 });
    expect(p.backoff).toBe(0);
    expect(p.maxAttempts).toBe(3);
    expect(Object.isFrozen(p)).toBe(true);
  });
});
