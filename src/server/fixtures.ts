import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ProductionProcess, QualificationRecord, RulePackage } from "../shared/types.js";
import { ruleDigest } from "../shared/rules.js";
import type { WitnessDb } from "./db.js";

export function loadFixtureData(root: string): {
  rules: RulePackage[];
  records: QualificationRecord[];
  production: ProductionProcess;
} {
  const rules = readdirSync(join(root, "rules"))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(root, "rules", f), "utf8")) as RulePackage);
  const records = JSON.parse(readFileSync(join(root, "fixtures", "records.json"), "utf8")) as QualificationRecord[];
  const production = JSON.parse(readFileSync(join(root, "fixtures", "production.json"), "utf8")) as ProductionProcess;
  return { rules, records, production };
}

/** 清空并重新导入固定 fixture，用于复核重放。 */
export function importFixtures(db: WitnessDb, root: string): void {
  const { rules, records, production } = loadFixtureData(root);
  db.wipe();
  for (const rule of rules) db.putRule(rule, ruleDigest(rule));
  for (const rec of records) db.putRecord(rec);
  db.putProduction(production);
}
