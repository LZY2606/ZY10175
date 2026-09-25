import { createHash } from "node:crypto";
import type { Interval, RulePackage, VariableRule } from "./types.js";
import { evalCondition, evalNumber } from "./expr.js";

/** 键序稳定的 JSON 序列化，用于固定规则包摘要。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function ruleDigest(rule: RulePackage): string {
  return createHash("sha256").update(canonicalJson(rule)).digest("hex");
}

/** 由实测值与区间扩展规则计算该试件在某变量上的合格区间。 */
export function qualifiedInterval(
  variable: VariableRule,
  measured: number,
  nominal: number | undefined,
): Interval {
  if (!variable.extension) throw new Error(`变量 ${variable.key} 缺少区间扩展规则`);
  const scope: Record<string, number> = { value: measured };
  if (variable.measuredVar) scope[variable.measuredVar] = measured;
  if (nominal !== undefined) scope.nominal = nominal;
  for (const c of variable.extension.cases) {
    if (evalCondition(c.when, scope)) {
      return {
        lower: c.lower === null ? null : evalNumber(c.lower, scope),
        upper: c.upper === null ? null : evalNumber(c.upper, scope),
        lowerBound: c.lowerBound,
        upperBound: c.upperBound,
      };
    }
  }
  throw new Error(`变量 ${variable.key} 的区间扩展没有命中任何分支`);
}

export interface Containment {
  inside: boolean;
  /** 恰好在界限上时，按规则声明的开闭判定；此处记录是否落在被排除的边界上。 */
  onExcludedBoundary: boolean;
  /** 到区间的距离；在区间内（含被排除边界）为 0。 */
  distance: number;
}

export function containment(interval: Interval, value: number): Containment {
  const { lower, upper, lowerBound, upperBound } = interval;
  if (lower !== null && value < lower) return { inside: false, onExcludedBoundary: false, distance: lower - value };
  if (upper !== null && value > upper) return { inside: false, onExcludedBoundary: false, distance: value - upper };
  if (lower !== null && value === lower && lowerBound === "open") {
    return { inside: false, onExcludedBoundary: true, distance: 0 };
  }
  if (upper !== null && value === upper && upperBound === "open") {
    return { inside: false, onExcludedBoundary: true, distance: 0 };
  }
  return { inside: true, onExcludedBoundary: false, distance: 0 };
}

export function formatInterval(iv: Interval, unit?: string): string {
  const l = iv.lower === null ? "-∞" : String(round(iv.lower));
  const u = iv.upper === null ? "+∞" : String(round(iv.upper));
  const s = `${iv.lowerBound === "closed" ? "[" : "("}${l}, ${u}${iv.upperBound === "closed" ? "]" : ")"}`;
  return unit ? `${s} ${unit}` : s;
}

export function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
