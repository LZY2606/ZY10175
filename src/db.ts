import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

let dbInstance: DatabaseSync | null = null;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

export function getDatabase(): DatabaseSync {
  if (dbInstance === null) {
    const path = process.env.WWS_DB_PATH ?? "data/witness.sqlite";
    dbInstance = openDatabase(path);
  }
  return dbInstance;
}

export function setDatabase(db: DatabaseSync): void {
  dbInstance = db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rule_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_id TEXT NOT NULL,
      version TEXT NOT NULL,
      content TEXT NOT NULL,
      digest TEXT NOT NULL,
      version_digest TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(package_id, version)
    );

    CREATE TABLE IF NOT EXISTS rule_package_meta (
      package_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      digest TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('valid','expired','withdrawn')),
      valid_from TEXT,
      valid_until TEXT,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS coupon_variables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coupon_id INTEGER NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
      variable TEXT NOT NULL,
      nominal REAL,
      measured REAL,
      text_value TEXT,
      unit TEXT
    );

    CREATE TABLE IF NOT EXISTS mechanical_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coupon_id INTEGER NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
      test_type TEXT NOT NULL,
      result TEXT NOT NULL CHECK(result IN ('pass','fail')),
      value REAL,
      unit TEXT,
      tested_at TEXT
    );

    CREATE TABLE IF NOT EXISTS production_specs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS production_variables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      spec_id INTEGER NOT NULL REFERENCES production_specs(id) ON DELETE CASCADE,
      variable TEXT NOT NULL,
      nominal REAL,
      measured REAL,
      text_value TEXT,
      unit TEXT
    );

    CREATE TABLE IF NOT EXISTS evaluation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_id TEXT NOT NULL,
      version TEXT NOT NULL,
      digest TEXT NOT NULL,
      spec_name TEXT,
      spec_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      conclusion TEXT NOT NULL CHECK(conclusion IN ('COVERED','NOT_COVERED')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export interface ExportBundle {
  exportedAt: string;
  rulePackages: { content: unknown }[];
  coupons: unknown;
  productionSpecs: unknown;
  evaluationRuns: unknown;
}

export function exportBundle(db: DatabaseSync): ExportBundle {
  return {
    exportedAt: new Date().toISOString(),
    rulePackages: db
      .prepare("SELECT content FROM rule_package_meta ORDER BY package_id")
      .all()
      .map((row) => ({ content: JSON.parse(row.content as string) as unknown })),
    coupons: db
      .prepare(
        `SELECT c.id, c.code, c.status, c.valid_from AS validFrom, c.valid_until AS validUntil, c.note,
                (SELECT json_group_array(json_object(
                   'variable', variable, 'nominal', nominal, 'measured', measured,
                   'text', text_value, 'unit', unit))
                   FROM coupon_variables v WHERE v.coupon_id = c.id) AS variables,
                (SELECT json_group_array(json_object(
                   'testType', test_type, 'result', result, 'value', value,
                   'unit', unit, 'testedAt', tested_at))
                   FROM mechanical_tests m WHERE m.coupon_id = c.id) AS mechanical
         FROM coupons c ORDER BY c.code`,
      )
      .all()
      .map((row) => ({ ...row, variables: JSON.parse(row.variables as string), mechanical: JSON.parse(row.mechanical as string) })),
    productionSpecs: db
      .prepare(
        `SELECT s.id, s.name,
                (SELECT json_group_array(json_object(
                   'variable', variable, 'nominal', nominal, 'measured', measured,
                   'text', text_value, 'unit', unit))
                   FROM production_variables v WHERE v.spec_id = s.id) AS variables
         FROM production_specs s ORDER BY s.name`,
      )
      .all()
      .map((row) => ({ ...row, variables: JSON.parse(row.variables as string) })),
    evaluationRuns: db
      .prepare(
        `SELECT id, package_id AS packageId, version, digest, spec_name AS specName,
                spec_json AS specJson, result_json AS resultJson, conclusion, created_at AS createdAt
         FROM evaluation_runs ORDER BY id`,
      )
      .all(),
  };
}
