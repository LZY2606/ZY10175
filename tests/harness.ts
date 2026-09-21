import { openDatabase } from "../src/db.ts";
import type { DatabaseSync } from "node:sqlite";
import { replayFixturesAsync, loadFixtureFiles } from "../src/fixture.ts";
import { evaluate } from "../src/engine.ts";
import type { CouponInput, ProductionSpec, RulePackage, RuleVersion } from "../src/types.ts";

export interface TestContext {
  db: DatabaseSync;
  pkg: RulePackage;
  coupons: CouponInput[];
  specs: ProductionSpec[];
}

export async function setupContext(): Promise<TestContext> {
  const db = openDatabase(":memory:");
  const fixtures = await loadFixtureFiles();
  await replayFixturesAsync(db);
  return { db, pkg: fixtures.pkg, coupons: fixtures.coupons, specs: fixtures.specs };
}

export function versionOf(pkg: RulePackage, version: string): RuleVersion {
  const found = pkg.versions.find((candidate) => candidate.version === version);
  if (!found) {
    throw new Error(`fixture 缺少版本 ${version}`);
  }
  return found;
}

export function specByName(specs: ProductionSpec[], name: string): ProductionSpec {
  const found = specs.find((candidate) => candidate.name.includes(name));
  if (!found) {
    throw new Error(`fixture 缺少工艺 ${name}`);
  }
  return { name: found.name, variables: found.variables };
}

export function couponByCode(coupons: CouponInput[], code: string): CouponInput {
  const found = coupons.find((candidate) => candidate.code === code);
  if (!found) {
    throw new Error(`fixture 缺少试件 ${code}`);
  }
  return found;
}

export { evaluate };
