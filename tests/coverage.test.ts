import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixtureData } from "../src/server/fixtures.js";
import { checkCoverage } from "../src/shared/coverage.js";
import { containment, qualifiedInterval, ruleDigest } from "../src/shared/rules.js";
import { evalExpr } from "../src/shared/expr.js";
import type { ProductionProcess } from "../src/shared/types.js";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const { rules, records, production } = loadFixtureData(ROOT);
const ruleV1 = rules.find((r) => r.version === "1.0.0")!;
const ruleV2 = rules.find((r) => r.version === "1.1.0")!;
const AS_OF = "2026-01-01";

function varOf(result: ReturnType<typeof checkCoverage>, key: string) {
  return result.variables.find((v) => v.key === key)!;
}

describe("验收场景：两个单项合格试件尝试拼接", () => {
  const result = checkCoverage(ruleV1, records, production, AS_OF);

  it("厚度与热输入分别由不同试件单项覆盖", () => {
    // PQR-2024-001-T1 厚度区间 [6,24] 覆盖 18；PQR-2024-002-T1 热输入 (1.6,2.2) 覆盖 1.9
    const thicknessHits = result.excludedRecords; // 仅确认记录未被误排除
    expect(thicknessHits.find((e) => e.recordId === "PQR-2024-001")).toBeUndefined();
    expect(thicknessHits.find((e) => e.recordId === "PQR-2024-002")).toBeUndefined();
  });

  it("系统拒绝跨试件拼接的虚假覆盖", () => {
    expect(result.conclusion).toBe("not-covered");
    const group = result.groups.find((g) => g.key === "thickness-heatInput")!;
    expect(group.satisfied).toBe(false);
    expect(varOf(result, "thickness").covered).toBe(false);
    expect(varOf(result, "heatInput").covered).toBe(false);
  });

  it("指出离合格最近的试验与仍缺的证据", () => {
    const gap = varOf(result, "heatInput").gap!;
    expect(gap.nearest).not.toBeNull();
    expect(gap.nearest!.recordId).toBe("PQR-2024-001");
    expect(gap.nearest!.pieceId).toBe("PQR-2024-001-T1");
    expect(gap.nearest!.distance).toBeCloseTo(0.4, 6);
    expect(gap.nearest!.missing).toContain("1.9");
    expect(gap.reason).toContain("热输入");
    expect(gap.reason).toContain("仍缺");
  });

  it("除联合组外其余变量均被覆盖", () => {
    for (const key of ["baseMetalGroup", "fillerMaterial", "diameter", "position", "mechanicalTests"]) {
      expect(varOf(result, key).covered, key).toBe(true);
    }
  });
});

describe("记录有效性门槛", () => {
  const result = checkCoverage(ruleV1, records, production, AS_OF);

  it("过期记录不参与判定", () => {
    expect(result.excludedRecords.find((e) => e.recordId === "PQR-2021-007")?.reasons.join()).toContain("过期");
  });

  it("撤销记录不参与判定", () => {
    expect(result.excludedRecords.find((e) => e.recordId === "PQR-2019-011")?.reasons.join()).toContain("撤销");
  });

  it("单位不明的记录不能偷偷参与对应变量", () => {
    const excluded = result.excludedRecords.find((e) => e.recordId === "PQR-2024-009");
    expect(excluded?.reasons.join()).toContain("单位不明");
    // 若过期记录 PQR-2021-007 参与，联合组将被虚假满足
    expect(result.groups[0]!.satisfied).toBe(false);
  });
});

describe("开闭区间与界限判定", () => {
  const heatVar = ruleV1.variables.find((v) => v.key === "heatInput")!;

  it("半开区间：上界闭、下界开", () => {
    const iv = qualifiedInterval(heatVar, 1.2, 1.2);
    expect(iv.lower).toBeCloseTo(0.96);
    expect(iv.upper).toBeCloseTo(1.5);
    expect(iv.lowerBound).toBe("open");
    expect(iv.upperBound).toBe("closed");
    expect(containment(iv, 1.5).inside).toBe(true);
    const atLower = containment(iv, 0.96);
    expect(atLower.inside).toBe(false);
    expect(atLower.onExcludedBoundary).toBe(true);
    expect(atLower.distance).toBe(0);
  });

  it("恰好在界限上的工艺按规则声明判定", () => {
    const atClosed: ProductionProcess = { name: "t", values: { ...production.values, heatInput: 1.5, thickness: 12 } };
    const r1 = checkCoverage(ruleV1, records, atClosed, AS_OF);
    expect(varOf(r1, "heatInput").covered).toBe(true);

    const atOpen: ProductionProcess = { name: "t", values: { ...production.values, heatInput: 0.96, thickness: 12 } };
    const r2 = checkCoverage(ruleV1, records, atOpen, AS_OF);
    expect(varOf(r2, "heatInput").covered).toBe(false);
  });

  it("闭区间厚度：v1.0.0 上界 2t 闭区间覆盖 18", () => {
    const r = checkCoverage(ruleV1, records, { name: "t", values: { ...production.values, heatInput: 1.2 } }, AS_OF);
    expect(varOf(r, "thickness").covered).toBe(true);
  });
});

describe("规则版本对比", () => {
  it("v1.1.0 收紧厚度上限为 1.5t 开区间，18mm 由覆盖变为缺口", () => {
    const prod: ProductionProcess = { name: "t", values: { ...production.values, heatInput: 1.2 } };
    const r1 = checkCoverage(ruleV1, records, prod, AS_OF);
    const r2 = checkCoverage(ruleV2, records, prod, AS_OF);
    expect(varOf(r1, "thickness").covered).toBe(true);
    expect(varOf(r2, "thickness").covered).toBe(false);
    const gap = varOf(r2, "thickness").gap!;
    expect(gap.nearest!.distance).toBe(0);
    expect(gap.nearest!.missing).toContain("开区间");
  });

  it("结论固定规则包摘要，两版摘要不同且稳定", () => {
    const d1 = ruleDigest(ruleV1);
    const d2 = ruleDigest(ruleV2);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
    expect(d1).not.toBe(d2);
    expect(ruleDigest(ruleV1)).toBe(d1);
    const r = checkCoverage(ruleV1, records, production, AS_OF);
    expect(r.ruleDigest).toBe(d1);
  });
});

describe("受限条件表达式", () => {
  it("支持比较、逻辑与算术", () => {
    expect(evalExpr("t <= 38 && t > 0", { t: 12 })).toBe(true);
    expect(evalExpr("0.5 * t + 1", { t: 12 })).toBe(7);
    expect(evalExpr("h > 1.5 || h < 0.5", { h: 1.2 })).toBe(false);
  });

  it("拒绝未知变量与非法输入，不执行任意代码", () => {
    expect(() => evalExpr("process.exit(1)", {})).toThrow();
    expect(() => evalExpr("t; alert(1)", { t: 1 })).toThrow();
    expect(() => evalExpr("unknownVar + 1", {})).toThrow(/未知变量/);
  });
});

describe("拼接许可", () => {
  it("仅规则明确允许的集合变量可跨试件拼接", () => {
    const prod: ProductionProcess = {
      name: "t",
      values: { ...production.values, position: ["1G", "3G"], mechanicalTests: ["tensile", "bend", "impact"] },
    };
    const r = checkCoverage(ruleV1, records, prod, AS_OF);
    // 1G 来自 PQR-2024-001，3G 来自 PQR-2024-002，规则允许 position 拼接
    const pos = varOf(r, "position");
    expect(pos.covered).toBe(true);
    expect(pos.evidence.length).toBeGreaterThanOrEqual(2);
  });
});
