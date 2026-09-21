/**
 * 清空数据库并从固定 fixture 重放：
 *   corepack pnpm replay
 * 环境变量 WWS_DB_PATH 可指定数据库文件（默认 data/witness.sqlite）。
 */
import { openDatabase } from "../src/db.ts";
import { clearAllData } from "../src/store.ts";
import { replayFixturesAsync } from "../src/fixture.ts";

const path = process.env.WWS_DB_PATH ?? "data/witness.sqlite";
const db = openDatabase(path);
clearAllData(db);
await replayFixturesAsync(db);
const counts = {
  versions: (db.prepare("SELECT COUNT(*) AS n FROM rule_packages").get() as { n: number }).n,
  coupons: (db.prepare("SELECT COUNT(*) AS n FROM coupons").get() as { n: number }).n,
  specs: (db.prepare("SELECT COUNT(*) AS n FROM production_specs").get() as { n: number }).n,
};
console.log(`重放完成 -> ${path}`, counts);
db.close();
