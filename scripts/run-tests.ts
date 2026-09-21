/**
 * 零依赖测试运行器：自动发现 tests/*.test.ts，顺序执行。
 * `corepack pnpm test -- --run` 中的 --run 会被透传，这里忽略（测试始终单次运行后退出）。
 */
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const testDir = join(here, "..", "tests");

interface TestCase {
  name: string;
  fn: () => void | Promise<void>;
}
const cases: TestCase[] = [];

globalThis.describe = (name: string, fn: () => void): void => {
  globalThis.__suite = name;
  fn();
};
globalThis.it = (name: string, fn: () => void | Promise<void>): void => {
  const suite = globalThis.__suite ?? "";
  cases.push({ name: `${suite} › ${name}`, fn });
};

const fail = (message: string): never => {
  throw new Error(message);
};
globalThis.assert = {
  ok(value: unknown, message = "expected truthy"): void {
    if (!value) fail(message);
  },
  equal(actual: unknown, expected: unknown, message?: string): void {
    if (!Object.is(actual, expected)) {
      fail(message ?? `expected ${String(expected)}, got ${String(actual)}`);
    }
  },
  deepEqual(actual: unknown, expected: unknown, message?: string): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  },
  includes<T>(haystack: T[], needle: T, message?: string): void {
    if (!haystack.includes(needle)) {
      fail(message ?? `expected ${JSON.stringify(haystack)} to include ${String(needle)}`);
    }
  },
  throws(fn: () => unknown, fragment: string): void {
    try {
      fn();
    } catch (error) {
      if (!String((error as Error).message).includes(fragment)) {
        fail(`expected error containing ${fragment}, got ${(error as Error).message}`);
      }
      return;
    }
    fail(`expected throw containing ${fragment}`);
  },
};

const files = readdirSync(testDir).filter((name) => name.endsWith(".test.ts"));
for (const file of files) {
  await import(pathToFileURL(join(testDir, file)).href);
}

let passed = 0;
const failures: Array<{ name: string; error: Error }> = [];
for (const testCase of cases) {
  try {
    await testCase.fn();
    passed += 1;
    console.log(`  \u2713 ${testCase.name}`);
  } catch (error) {
    failures.push({ name: testCase.name, error: error as Error });
    console.log(`  \u2717 ${testCase.name}`);
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\nFAIL ${failure.name}\n  ${failure.error.stack ?? failure.error.message}`);
  }
  process.exit(1);
}
const cleanup = (globalThis as { __cleanupServer?: () => Promise<void> }).__cleanupServer;
if (cleanup) {
  await cleanup();
}
process.exit(0);
