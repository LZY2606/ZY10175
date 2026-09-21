import type { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { CouponInput, ProductionSpec, RulePackage } from "./types.ts";
import { replaceCoupons, replaceSpecs, upsertRulePackage } from "./store.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "fixtures");

export async function loadFixtureFiles(): Promise<{
  pkg: RulePackage;
  coupons: CouponInput[];
  specs: ProductionSpec[];
}> {
  const [rulesRaw, couponsRaw, specsRaw] = await Promise.all([
    readFile(join(fixtureDir, "rules.json"), "utf-8"),
    readFile(join(fixtureDir, "coupons.json"), "utf-8"),
    readFile(join(fixtureDir, "specs.json"), "utf-8"),
  ]);
  const rules = JSON.parse(rulesRaw) as RulePackage;
  const coupons = (JSON.parse(couponsRaw) as { coupons: CouponInput[] }).coupons;
  const specs = (JSON.parse(specsRaw) as { specs: ProductionSpec[] }).specs;
  validateFixture(rules, coupons, specs);
  return { pkg: rules, coupons, specs };
}

export function validateFixture(pkg: RulePackage, coupons: CouponInput[], specs: ProductionSpec[]): void {
  if (!pkg.packageId || !Array.isArray(pkg.versions) || pkg.versions.length < 2) {
    throw new Error("规则包 fixture 非法：至少需要两个版本");
  }
  for (const version of pkg.versions) {
    for (const name of version.requiredVariables) {
      if (!version.variables[name]) {
        throw new Error(`规则版本 ${version.version} 声明变量 ${name} 但缺少定义`);
      }
    }
    for (const group of version.jointGroups) {
      for (const name of group.variables) {
        if (!version.requiredVariables.includes(name)) {
          throw new Error(`联合组 ${group.id} 含未声明变量 ${name}`);
        }
      }
    }
  }
  const couponCodes = new Set(coupons.map((coupon) => coupon.code));
  if (couponCodes.size !== coupons.length) {
    throw new Error("试件编码重复");
  }
  for (const spec of specs) {
    if (!spec.name) {
      throw new Error("生产工艺缺少名称");
    }
  }
}

export async function replayFixturesAsync(db: DatabaseSync): Promise<void> {
  const { pkg, coupons, specs } = await loadFixtureFiles();
  upsertRulePackage(db, pkg);
  replaceCoupons(db, coupons);
  replaceSpecs(db, specs);
}

export async function replayFixtures(db: DatabaseSync): Promise<void> {
  await replayFixturesAsync(db);
}

export async function seedIfEmpty(db: DatabaseSync): Promise<boolean> {
  const row = db.prepare("SELECT COUNT(*) AS n FROM rule_package_meta").get() as { n: number };
  if (row.n > 0) {
    return false;
  }
  await replayFixturesAsync(db);
  return true;
}
