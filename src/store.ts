import type { DatabaseSync } from "node:sqlite";
import type {
  CouponInput,
  MechanicalTestInput,
  ProductionSpec,
  RulePackage,
  RuleVersion,
} from "./types.ts";
import { digestPackage, digestVersion } from "./digest.ts";

export interface StoredCouponVariable {
  variable: string;
  nominal: number | null;
  measured: number | null;
  text: string | null;
  unit: string | null;
}

export interface StoredMechanical extends MechanicalTestInput {}

export interface StoredCoupon extends CouponInput {
  id: number;
}

export interface StoredSpec extends ProductionSpec {
  id: number;
}

export function upsertRulePackage(db: DatabaseSync, pkg: RulePackage): void {
  const packageDigest = digestPackage(pkg);
  db.prepare(
    `INSERT INTO rule_package_meta (package_id, content, digest)
     VALUES (?, ?, ?)
     ON CONFLICT(package_id) DO UPDATE SET content = excluded.content, digest = excluded.digest`,
  ).run(pkg.packageId, JSON.stringify(pkg), packageDigest);
  const insert = db.prepare(
    `INSERT INTO rule_packages (package_id, version, content, digest, version_digest)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(package_id, version) DO UPDATE SET
       content = excluded.content,
       digest = excluded.digest,
       version_digest = excluded.version_digest`,
  );
  for (const version of pkg.versions) {
    const versionDigest = digestVersion(version);
    insert.run(version.packageId, version.version, JSON.stringify(version), packageDigest, versionDigest);
  }
}

export function loadPackage(db: DatabaseSync, packageId: string): RulePackage | null {
  const row = db
    .prepare("SELECT content FROM rule_package_meta WHERE package_id = ?")
    .get(packageId) as { content: string } | undefined;
  return row ? (JSON.parse(row.content) as RulePackage) : null;
}

export function firstPackageId(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT package_id AS packageId FROM rule_package_meta LIMIT 1").get() as
    | { packageId: string }
    | undefined;
  return row?.packageId ?? null;
}

export function loadRuleVersion(db: DatabaseSync, packageId: string, version: string): RuleVersion | null {
  const row = db
    .prepare("SELECT content FROM rule_packages WHERE package_id = ? AND version = ?")
    .get(packageId, version) as { content: string } | undefined;
  return row ? (JSON.parse(row.content) as RuleVersion) : null;
}

export function listRuleVersions(db: DatabaseSync, packageId: string): Array<{ version: string; label: string; publishedAt: string; digest: string; versionDigest: string }> {
  return (db
    .prepare(
      `SELECT version, content, digest, version_digest AS versionDigest
       FROM rule_packages WHERE package_id = ?`,
    )
    .all(packageId) as Array<{ version: string; content: string; digest: string; versionDigest: string }>)
    .map((row) => {
      const content = JSON.parse(row.content) as RuleVersion;
      return {
        version: row.version,
        label: content.label,
        publishedAt: content.publishedAt,
        digest: row.digest,
        versionDigest: row.versionDigest,
      };
    })
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
}

export function replaceCoupons(db: DatabaseSync, coupons: CouponInput[]): void {
  const insertCoupon = db.prepare(
    `INSERT INTO coupons (code, status, valid_from, valid_until, note)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET
       status = excluded.status,
       valid_from = excluded.valid_from,
       valid_until = excluded.valid_until,
       note = excluded.note`,
  );
  const insertVar = db.prepare(
    `INSERT INTO coupon_variables (coupon_id, variable, nominal, measured, text_value, unit)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertMech = db.prepare(
    `INSERT INTO mechanical_tests (coupon_id, test_type, result, value, unit, tested_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const clearVars = db.prepare("DELETE FROM coupon_variables WHERE coupon_id = ?");
  const clearMech = db.prepare("DELETE FROM mechanical_tests WHERE coupon_id = ?");
  for (const coupon of coupons) {
    insertCoupon.run(coupon.code, coupon.status, coupon.validFrom ?? null, coupon.validUntil ?? null, coupon.note ?? null);
    const row = db.prepare("SELECT id FROM coupons WHERE code = ?").get(coupon.code) as { id: number };
    clearVars.run(row.id);
    clearMech.run(row.id);
    for (const variable of coupon.variables) {
      insertVar.run(
        row.id,
        variable.variable,
        variable.nominal ?? null,
        variable.measured ?? null,
        variable.text ?? null,
        variable.unit ?? null,
      );
    }
    for (const test of coupon.mechanical) {
      insertMech.run(row.id, test.testType, test.result, test.value ?? null, test.unit ?? null, test.testedAt ?? null);
    }
  }
}

export function replaceSpecs(db: DatabaseSync, specs: ProductionSpec[]): void {
  const insertSpec = db.prepare(
    `INSERT INTO production_specs (name) VALUES (?)
     ON CONFLICT(name) DO UPDATE SET name = excluded.name`,
  );
  const insertVar = db.prepare(
    `INSERT INTO production_variables (spec_id, variable, nominal, measured, text_value, unit)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const clearVars = db.prepare("DELETE FROM production_variables WHERE spec_id = ?");
  for (const spec of specs) {
    insertSpec.run(spec.name);
    const row = db.prepare("SELECT id FROM production_specs WHERE name = ?").get(spec.name) as { id: number };
    clearVars.run(row.id);
    for (const variable of spec.variables) {
      insertVar.run(
        row.id,
        variable.variable,
        variable.nominal ?? null,
        variable.measured ?? null,
        variable.text ?? null,
        variable.unit ?? null,
      );
    }
  }
}

export function loadCoupons(db: DatabaseSync): StoredCoupon[] {
  const couponRows = db.prepare("SELECT id, code, status, valid_from AS validFrom, valid_until AS validUntil, note FROM coupons ORDER BY id").all() as Array<{
    id: number;
    code: string;
    status: StoredCoupon["status"];
    validFrom: string | null;
    validUntil: string | null;
    note: string | null;
  }>;
  const varRows = db.prepare("SELECT coupon_id AS couponId, variable, nominal, measured, text_value AS text, unit FROM coupon_variables ORDER BY id").all() as unknown as Array<StoredCouponVariable & { couponId: number }>;
  const mechRows = db.prepare("SELECT coupon_id AS couponId, test_type AS testType, result, value, unit, tested_at AS testedAt FROM mechanical_tests ORDER BY id").all() as unknown as Array<MechanicalTestInput & { couponId: number }>;
  return couponRows.map((row) => ({
    id: row.id,
    code: row.code,
    status: row.status,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    note: row.note,
    variables: varRows.filter((v) => v.couponId === row.id).map(({ couponId: _ignored, ...rest }) => rest),
    mechanical: mechRows.filter((m) => m.couponId === row.id).map(({ couponId: _ignored, ...rest }) => rest),
  }));
}

export function loadSpecs(db: DatabaseSync): StoredSpec[] {
  const specRows = db.prepare("SELECT id, name FROM production_specs ORDER BY id").all() as Array<{ id: number; name: string }>;
  const varRows = db.prepare("SELECT spec_id AS specId, variable, nominal, measured, text_value AS text, unit FROM production_variables ORDER BY id").all() as Array<{
    specId: number;
    variable: string;
    nominal: number | null;
    measured: number | null;
    text: string | null;
    unit: string | null;
  }>;
  return specRows.map((row) => ({
    id: row.id,
    name: row.name,
    variables: varRows.filter((v) => v.specId === row.id).map(({ specId: _ignored, ...rest }) => rest),
  }));
}

export function clearAllData(db: DatabaseSync): void {
  db.exec(
    `DELETE FROM evaluation_runs;
     DELETE FROM mechanical_tests;
     DELETE FROM coupon_variables;
     DELETE FROM coupons;
     DELETE FROM production_variables;
     DELETE FROM production_specs;
     DELETE FROM rule_packages;
     DELETE FROM rule_package_meta;`,
  );
}
