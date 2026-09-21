import { compareVersions } from "../src/engine.ts";
import { setupContext } from "./harness.ts";

describe("规则版本范围比较", () => {
  it("2025 版厚度相对 2024 版收窄，热输入放宽且上界变开", async () => {
    const ctx = await setupContext();
    const from = ctx.pkg.versions.find((v) => v.version === "2024.1")!;
    const to = ctx.pkg.versions.find((v) => v.version === "2025.0")!;
    const changes = compareVersions(from, to, { thickness: 10, heatInput: 1, diameter: 200 });

    const thickness = changes.find((change) => change.variable === "thickness");
    assert.equal(thickness?.change, "narrowed");
    assert.deepEqual(thickness?.from, { lowerExpr: "0.5 * v", upperExpr: "2 * v", lowerBound: "closed", upperBound: "closed" });
    assert.deepEqual(thickness?.to, { lowerExpr: "0.7 * v", upperExpr: "1.5 * v", lowerBound: "closed", upperBound: "closed" });
    assert.deepEqual(thickness?.sample.fromRange, [5, 20]);
    assert.deepEqual(thickness?.sample.toRange, [7, 15]);

    const heat = changes.find((change) => change.variable === "heatInput");
    assert.equal(heat?.change, "widened");
    assert.equal(heat?.to?.upperBound, "open");
    assert.deepEqual(heat?.sample.toRange, [0.5, 1.2]);

    const diameter = changes.find((change) => change.variable === "diameter");
    assert.equal(diameter?.change, "unchanged");
  });

  it("拼接策略从禁止变为允许", async () => {
    const ctx = await setupContext();
    const from = ctx.pkg.versions.find((v) => v.version === "2024.1")!;
    const to = ctx.pkg.versions.find((v) => v.version === "2025.0")!;
    assert.equal(from.stitching, "forbidden");
    assert.equal(to.stitching, "permitted");
    assert.equal(from.jointGroups.length, 1);
    assert.equal(to.jointGroups.length, 2);
  });
});
