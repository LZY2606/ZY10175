import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CoverageResult, ProductionProcess, QualificationRecord, RulePackage } from "../shared/types.js";

export interface CheckRun {
  id: number;
  createdAt: string;
  kind: "check" | "compare";
  ruleVersion: string;
  ruleDigest: string;
  input: unknown;
  result: unknown;
}

export class WitnessDb {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rule_packages (
        version TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        digest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS production_process (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS check_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        rule_digest TEXT NOT NULL,
        input TEXT NOT NULL,
        result TEXT NOT NULL
      );
    `);
  }

  close(): void { this.db.close(); }

  isEmpty(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM rule_packages").get() as { n: number };
    return row.n === 0;
  }

  wipe(): void {
    this.db.exec("DELETE FROM check_runs; DELETE FROM records; DELETE FROM rule_packages; DELETE FROM production_process;");
  }

  putRule(rule: RulePackage, digest: string): void {
    this.db.prepare("INSERT OR REPLACE INTO rule_packages (version, json, digest) VALUES (?, ?, ?)")
      .run(rule.version, JSON.stringify(rule), digest);
  }

  listRules(): { rule: RulePackage; digest: string }[] {
    const rows = this.db.prepare("SELECT json, digest FROM rule_packages ORDER BY version").all() as { json: string; digest: string }[];
    return rows.map((r) => ({ rule: JSON.parse(r.json) as RulePackage, digest: r.digest }));
  }

  getRule(version: string): { rule: RulePackage; digest: string } | null {
    const row = this.db.prepare("SELECT json, digest FROM rule_packages WHERE version = ?").get(version) as { json: string; digest: string } | undefined;
    return row ? { rule: JSON.parse(row.json) as RulePackage, digest: row.digest } : null;
  }

  putRecord(rec: QualificationRecord): void {
    this.db.prepare("INSERT OR REPLACE INTO records (id, json) VALUES (?, ?)").run(rec.id, JSON.stringify(rec));
  }

  listRecords(): QualificationRecord[] {
    const rows = this.db.prepare("SELECT json FROM records ORDER BY id").all() as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as QualificationRecord);
  }

  putProduction(p: ProductionProcess): void {
    this.db.prepare("INSERT OR REPLACE INTO production_process (id, json) VALUES (1, ?)").run(JSON.stringify(p));
  }

  getProduction(): ProductionProcess | null {
    const row = this.db.prepare("SELECT json FROM production_process WHERE id = 1").get() as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as ProductionProcess) : null;
  }

  logRun(kind: "check" | "compare", ruleVersion: string, ruleDigest: string, input: unknown, result: unknown): number {
    const info = this.db.prepare(
      "INSERT INTO check_runs (created_at, kind, rule_version, rule_digest, input, result) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(new Date().toISOString(), kind, ruleVersion, ruleDigest, JSON.stringify(input), JSON.stringify(result));
    return Number(info.lastInsertRowid);
  }

  listRuns(limit = 100): CheckRun[] {
    const rows = this.db.prepare("SELECT * FROM check_runs ORDER BY id DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      createdAt: r.created_at as string,
      kind: r.kind as "check" | "compare",
      ruleVersion: r.rule_version as string,
      ruleDigest: r.rule_digest as string,
      input: JSON.parse(r.input as string),
      result: JSON.parse(r.result as string),
    }));
  }
}
