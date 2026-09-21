import { evalExpression } from "../src/expr.ts";

describe("受限表达式解析器", () => {
  it("支持数字、变量 v 与四则运算", () => {
    assert.equal(evalExpression("0.5 * v", 10), 5);
    assert.equal(evalExpression("2 * v", 5), 10);
    assert.equal(evalExpression("1.2 * v", 10), 12);
    assert.equal(evalExpression("v / 2 + 1", 8), 5);
    assert.equal(evalExpression("-v", 3), -3);
  });

  it("拒绝标识符（除 v 外）", () => {
    assert.throws(() => evalExpression("foo + 1", 1), "不允许的标识符");
  });

  it("拒绝函数调用", () => {
    assert.throws(() => evalExpression("require('fs')", 1), "非法字符");
  });

  it("拒绝成员访问", () => {
    assert.throws(() => evalExpression("v.constructor", 1), "非法字符");
  });

  it("拒绝全局对象与字符串", () => {
    assert.throws(() => evalExpression("globalThis", 1), "不允许的标识符");
  });

  it("除零抛出错误", () => {
    assert.throws(() => evalExpression("v / 0", 2), "除数为零");
  });
});
