import { setupContext, versionOf, specByName, couponByCode, evaluate } from "./harness.ts";

describe("验收：两个单项合格试件的拼接", () => {
  const ctxPromise = setupContext();

  it("P1 工艺在 2025 版（允许按组拼接）下被完整覆盖", async () => {
    const ctx = await ctxPromise;
    const rule = versionOf(ctx.pkg, "2025.0");
    const spec = specByName(ctx.specs, "P1");
    const result = evaluate({ pkg: ctx.pkg, rule, spec, coupons: ctx.coupons });

    assert.equal(result.conclusion, "COVERED");
    const core = result.groups.find((group) => group.id === "joint-core");
    const heat = result.groups.find((group) => group.id === "joint-heat");
    assert.ok(core?.satisfied, "core 组应满足");
    assert.ok(heat?.satisfied, "heat 组应满足");
    assert.deepEqual(core?.satisfiedBy, ["PQR-A-007"]);
    assert.deepEqual(heat?.satisfiedBy, ["PQR-B-013"]);
  });

  it("同一组证据来自不同试件不被承认：core 组不能用 B 的厚度配 A 的母材", async () => {
    const ctx = await ctxPromise;
    const rule = versionOf(ctx.pkg, "2025.0");
    const spec = specByName(ctx.specs, "P1");
    const result = evaluate({ pkg: ctx.pkg, rule, spec, coupons: ctx.coupons });

    // B 的厚度本身命中 P1（14∈[7,15]），但 B 母材 Fe-3 不匹配；
    // A 的母材 Fe-1 命中。系统不得把两者拼成一个 core 组。
    const couponB = result.couponAssessments.find((coupon) => coupon.code === "PQR-B-013");
    assert.ok(couponB, "B 必须参与评估");
    assert.ok(!couponB?.coveredVariables.includes("baseMaterial"), "B 不覆盖母材 Fe-1");
    const core = result.groups.find((group) => group.id === "joint-core");
    assert.deepEqual(core?.satisfiedBy, ["PQR-A-007"]);
  });

  it("P1 工艺在 2024 版（禁止拼接）下被拒绝，且出现虚假拼接拒绝理由", async () => {
    const ctx = await ctxPromise;
    const rule = versionOf(ctx.pkg, "2024.1");
    const spec = specByName(ctx.specs, "P1");
    const result = evaluate({ pkg: ctx.pkg, rule, spec, coupons: ctx.coupons });

    assert.equal(result.conclusion, "NOT_COVERED");
    assert.ok(
      result.rejectionReasons.some((reason) => reason.includes("禁止跨试件拼接")),
      "应明确拒绝跨试件拼接",
    );
  });

  it("拒绝时指出离合格最近的试验及仍缺的证据", async () => {
    const ctx = await ctxPromise;
    const rule = versionOf(ctx.pkg, "2024.1");
    const spec = specByName(ctx.specs, "P1");
    const result = evaluate({ pkg: ctx.pkg, rule, spec, coupons: ctx.coupons });

    assert.ok(result.nearest, "应给出最近试验");
    assert.equal(result.nearest?.coveredCount, 5);
    assert.ok(
      result.nearest?.missingEvidence.some((line) => line.includes("position")) ||
        result.nearest?.missingEvidence.some((line) => line.includes("baseMaterial")),
      "应点名所缺变量证据",
    );
    assert.ok(result.nearest?.note.includes("禁止跨试件拼接"));
  });
});

describe("不合格记录不得偷偷参与", () => {
  const ctxPromise = setupContext();

  it("过期试件 WPQR-002 被排除", async () => {
    const ctx = await ctxPromise;
    const result = evaluate({
      pkg: ctx.pkg,
      rule: versionOf(ctx.pkg, "2024.1"),
      spec: specByName(ctx.specs, "P1"),
      coupons: ctx.coupons,
    });
    const expired = result.couponAssessments.find((coupon) => coupon.code === "WPQR-002");
    assert.equal(expired?.usable, false);
    assert.equal(expired?.excludedReason, "EXPIRED");
    assert.ok(result.rejectionReasons.some((reason) => reason.includes("WPQR-002") && reason.includes("过期")));
  });

  it("撤销试件 WPQR-003 被排除", async () => {
    const ctx = await ctxPromise;
    const result = evaluate({
      pkg: ctx.pkg,
      rule: versionOf(ctx.pkg, "2024.1"),
      spec: specByName(ctx.specs, "P1"),
      coupons: ctx.coupons,
    });
    const withdrawn = result.couponAssessments.find((coupon) => coupon.code === "WPQR-003");
    assert.equal(withdrawn?.usable, false);
    assert.equal(withdrawn?.excludedReason, "WITHDRAWN");
  });

  it("单位不明试件 WPQR-004 整条排除，其热输入证据不得出现", async () => {
    const ctx = await ctxPromise;
    const result = evaluate({
      pkg: ctx.pkg,
      rule: versionOf(ctx.pkg, "2025.0"),
      spec: specByName(ctx.specs, "P1"),
      coupons: ctx.coupons,
    });
    const unitUnknown = result.couponAssessments.find((coupon) => coupon.code === "WPQR-004");
    assert.equal(unitUnknown?.usable, false);
    assert.equal(unitUnknown?.excludedReason, "UNIT_UNKNOWN");
    const heat = result.variables.find((assessment) => assessment.variable === "heatInput");
    assert.ok(!heat?.evidence.some((evidence) => evidence.code === "WPQR-004"));
  });

  it("力学不合格试件 WPQR-006 不得作为证据", async () => {
    const ctx = await ctxPromise;
    const result = evaluate({
      pkg: ctx.pkg,
      rule: versionOf(ctx.pkg, "2024.1"),
      spec: specByName(ctx.specs, "P1"),
      coupons: ctx.coupons,
    });
    const broken = result.couponAssessments.find((coupon) => coupon.code === "WPQR-006");
    assert.equal(broken?.usable, false);
    assert.equal(broken?.excludedReason, "MECHANICAL_INCOMPLETE");
  });

  it("P3 在 2024 版由 WPQR-001 单一试件覆盖，2025 版因缺冲击项不再覆盖", async () => {
    const ctx = await ctxPromise;
    const spec = specByName(ctx.specs, "P3");
    const oldResult = evaluate({
      pkg: ctx.pkg,
      rule: versionOf(ctx.pkg, "2024.1"),
      spec,
      coupons: ctx.coupons,
    });
    assert.equal(oldResult.conclusion, "COVERED");
    const newResult = evaluate({
      pkg: ctx.pkg,
      rule: versionOf(ctx.pkg, "2025.0"),
      spec,
      coupons: ctx.coupons,
    });
    assert.equal(newResult.conclusion, "NOT_COVERED");
    assert.equal(newResult.nearest?.code, "WPQR-001");
    assert.deepEqual(newResult.nearest?.mechanicalMissing, ["impact"]);
  });
});
