import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

test('evalAllowed reports eval as allowed in Node', async () => {
  const { evalAllowed } = await import('../../src/core/csp.ts');
  expect(evalAllowed()).toBe(true);
});

test('evalAllowed is false when the CSP throws on new Function, and probes only once', async () => {
  let probes = 0;
  vi.stubGlobal('Function', function Blocked(): never {
    probes++;
    throw new EvalError("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not allowed");
  });
  const { evalAllowed } = await import('../../src/core/csp.ts');
  expect(evalAllowed()).toBe(false);
  expect(evalAllowed()).toBe(false);
  expect(probes).toBe(1);
});
