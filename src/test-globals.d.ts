declare global {
  var __suite: string | undefined;
  function describe(name: string, fn: () => void): void;
  function it(name: string, fn: () => void | Promise<void>): void;
  var assert: {
    ok(value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    includes<T>(haystack: T[], needle: T, message?: string): void;
    throws(fn: () => unknown, fragment: string): void;
  };
}

export {};
