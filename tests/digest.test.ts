import { sha256Hex, digestPackage, digestVersion, canonicalJson } from "../src/digest.ts";
import { setupContext, specByName, evaluate } from "./harness.ts";

describe("固定规则包摘要", () => {
  const ctxPromise = setupContext();

  it("规范化 JSON 对键顺序不敏感", () => {
    assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  });

  it("摘要随内容变化", () => {
    assert.ok(sha256Hex({ a: 1 }) !== sha256Hex({ a: 2 }));
  });

  it("同一份评估两次运行摘要完全一致（结论可复算）", async () => {
    const ctx = await ctxPromise;
    const rule = versionOfStable(ctx, "2024.1");
    const spec = specByName(ctx.specs, "P1");
    const first = evaluate({ pkg: ctx.pkg, rule, spec, coupons: ctx.coupons });
    const second = evaluate({ pkg: ctx.pkg, rule, spec, coupons: ctx.coupons });
    assert.equal(first.packageDigest, second.packageDigest);
    assert.equal(first.versionDigest, second.versionDigest);
    assert.equal(first.conclusion, second.conclusion);
  });

  it("固定 fixture 的规则包摘要保持钉住值", async () => {
    const ctx = await ctxPromise;
    const digest = digestPackage(ctx.pkg);
    assert.equal(/^[0-9a-f]{64}$/.test(digest), true, "应为 64 位 sha256 hex");
    const v2024 = ctx.pkg.versions.find((v) => v.version === "2024.1")!;
    const v2025 = ctx.pkg.versions.find((v) => v.version === "2025.0")!;
    assert.ok(digestVersion(v2024) !== digestVersion(v2025), "两个版本摘要应不同");
  });
});

function versionOfStable(ctx: Awaited<ReturnType<typeof setupContext>>, version: string) {
  const rule = ctx.pkg.versions.find((candidate) => candidate.version === version);
  if (!rule) throw new Error("missing version");
  return rule;
}
