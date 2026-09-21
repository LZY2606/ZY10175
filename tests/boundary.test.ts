import { membership } from "../src/engine.ts";
import type { IntervalVariableRule } from "../src/types.ts";

const closedThickness: IntervalVariableRule = {
  kind: "interval",
  unit: "mm",
  productionValue: "nominal",
  couponValue: "nominal",
  lower: { expr: "0.5 * v", bound: "closed" },
  upper: { expr: "2 * v", bound: "closed" },
};

const halfOpenHeat: IntervalVariableRule = {
  kind: "interval",
  unit: "kJ/mm",
  productionValue: "nominal",
  couponValue: "measured",
  lower: { expr: "0.5 * v", bound: "closed" },
  upper: { expr: "1.2 * v", bound: "open" },
};

const closedHeatAt12: IntervalVariableRule = {
  ...halfOpenHeat,
  upper: { expr: "1.2 * v", bound: "closed" },
};

describe("开闭区间界限判定", () => {
  it("闭区间：恰好落在下界与上界均判覆盖", () => {
    assert.equal(membership(5, 10, closedThickness).covered, true);
    assert.equal(membership(5, 10, closedThickness).boundary, "lower-boundary");
    assert.equal(membership(20, 10, closedThickness).covered, true);
    assert.equal(membership(20, 10, closedThickness).boundary, "upper-boundary");
  });

  it("闭区间：界限之外不覆盖", () => {
    assert.equal(membership(4.99, 10, closedThickness).covered, false);
    assert.equal(membership(20.01, 10, closedThickness).covered, false);
  });

  it("半开区间：恰好落在开的上界判不覆盖", () => {
    // 试件实测热输入 1.0：2025 版上界为 1.2Q=1.2（不含）
    assert.equal(membership(1.2, 1.0, halfOpenHeat).covered, false);
    assert.equal(membership(1.2, 1.0, halfOpenHeat).boundary, "upper-boundary");
  });

  it("半开区间：贴近但小于开上界仍覆盖", () => {
    assert.equal(membership(1.199, 1.0, halfOpenHeat).covered, true);
    assert.equal(membership(0.5, 1.0, halfOpenHeat).covered, true);
    assert.equal(membership(0.5, 1.0, halfOpenHeat).boundary, "lower-boundary");
  });

  it("同一工艺值在开上界拒绝、闭上界接受，差异完全由规则声明决定", () => {
    assert.equal(membership(1.2, 1.0, halfOpenHeat).covered, false);
    assert.equal(membership(1.2, 1.0, closedHeatAt12).covered, true);
  });
});
