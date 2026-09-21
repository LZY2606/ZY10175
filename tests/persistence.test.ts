import { openDatabase, exportBundle } from "../src/db.ts";
import { clearAllData, loadCoupons, loadSpecs, loadPackage, replaceCoupons } from "../src/store.ts";
import { replayFixturesAsync, loadFixtureFiles } from "../src/fixture.ts";
import { evaluate } from "../src/engine.ts";

describe("清空 / 重放 / 导出 / 导入复核", () => {
  it("清空数据库后可由 fixture 重放重建，记录数一致", async () => {
    const fixtures = await loadFixtureFiles();
    const db = openDatabase(":memory:");
    await replayFixturesAsync(db);
    assert.equal(loadCoupons(db).length, fixtures.coupons.length);
    assert.equal(loadSpecs(db).length, fixtures.specs.length);
    const pkg = loadPackage(db, fixtures.pkg.packageId);
    assert.equal(pkg?.versions.length, fixtures.pkg.versions.length);

    clearAllData(db);
    assert.equal(loadCoupons(db).length, 0);
    assert.equal(loadSpecs(db).length, 0);
    assert.equal(loadPackage(db, fixtures.pkg.packageId), null);

    await replayFixturesAsync(db);
    assert.equal(loadCoupons(db).length, fixtures.coupons.length);
  });

  it("导出包可导入新库并复算同一结论", async () => {
    const source = openDatabase(":memory:");
    await replayFixturesAsync(source);
    const pkg = loadPackage(source, "wws-welding-pqr")!;
    const rule = pkg.versions.find((v) => v.version === "2025.0")!;
    const spec = loadSpecs(source).find((candidate) => candidate.name.includes("P1"))!;
    const first = evaluate({ pkg, rule, spec, coupons: loadCoupons(source) });

    const bundle = exportBundle(source);
    const target = openDatabase(":memory:");
    for (const entry of bundle.rulePackages) {
      const loaded = entry.content as Parameters<typeof import("../src/store.ts").upsertRulePackage>[1];
      const { upsertRulePackage } = await import("../src/store.ts");
      upsertRulePackage(target, loaded);
    }
    replaceCoupons(target, bundle.coupons as Parameters<typeof replaceCoupons>[1]);
    const { replaceSpecs } = await import("../src/store.ts");
    replaceSpecs(target, bundle.productionSpecs as Parameters<typeof replaceSpecs>[1]);

    const reloadedPkg = loadPackage(target, "wws-welding-pqr")!;
    const reloadedRule = reloadedPkg.versions.find((v) => v.version === "2025.0")!;
    const reloadedSpec = loadSpecs(target).find((candidate) => candidate.name.includes("P1"))!;
    const again = evaluate({ pkg: reloadedPkg, rule: reloadedRule, spec: reloadedSpec, coupons: loadCoupons(target) });

    assert.equal(again.conclusion, first.conclusion);
    assert.equal(again.packageDigest, first.packageDigest);
    assert.equal(again.versionDigest, first.versionDigest);
  });
});
