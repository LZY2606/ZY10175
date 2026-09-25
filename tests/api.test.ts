import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WitnessDb } from "../src/server/db.js";
import { importFixtures } from "../src/server/fixtures.js";
import { buildServer } from "../src/server/main.js";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
let server: Server;
let base: string;
let db: WitnessDb;

beforeAll(async () => {
  db = new WitnessDb(":memory:");
  importFixtures(db, ROOT);
  server = buildServer(db);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  db.close();
});

const get = (p: string) => fetch(`${base}${p}`).then((r) => r.json());
const post = (p: string, body: unknown) =>
  fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

describe("API", () => {
  it("GET /api/state 返回规则、记录与默认工艺", async () => {
    const s = await get("/api/state");
    expect(s.rules.map((r: { version: string }) => r.version)).toEqual(["1.0.0", "1.1.0"]);
    expect(s.records.length).toBe(5);
    expect(s.production.name).toContain("WPS-DEMO");
    expect(s.rules[0].digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("POST /api/check 拒绝拼接并记录运行", async () => {
    const r = await post("/api/check", { ruleVersion: "1.0.0", asOf: "2026-01-01" });
    expect(r.conclusion).toBe("not-covered");
    expect(r.ruleDigest).toMatch(/^[0-9a-f]{64}$/);
    const group = r.groups.find((g: { key: string }) => g.key === "thickness-heatInput");
    expect(group.satisfied).toBe(false);
    expect(r.runId).toBeGreaterThan(0);
  });

  it("POST /api/compare 给出两版差异", async () => {
    const r = await post("/api/compare", { versions: ["1.0.0", "1.1.0"], asOf: "2026-01-01" });
    expect(r.a.ruleVersion).toBe("1.0.0");
    expect(r.b.ruleVersion).toBe("1.1.0");
    expect(r.diff.length).toBeGreaterThan(0);
    expect(r.a.ruleDigest).not.toBe(r.b.ruleDigest);
  });

  it("运行记录可导出，清空数据库后可重新导入复核", async () => {
    const before = await get("/api/export");
    expect(before.runs.length).toBeGreaterThanOrEqual(2);

    const reset = await post("/api/reset", {});
    expect(reset.ok).toBe(true);
    expect(reset.records).toBe(5);

    // 重导后运行记录已清空，规则与记录恢复，可复核出相同结论
    const after = await get("/api/export");
    expect(after.runs.length).toBe(0);
    const recheck = await post("/api/check", { ruleVersion: "1.0.0", asOf: "2026-01-01" });
    expect(recheck.conclusion).toBe("not-covered");
    expect(recheck.ruleDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("静态页面可访问且包含标题", async () => {
    const html = await fetch(`${base}/`).then((r) => r.text());
    expect(html).toContain("焊程见证台");
  });
});
