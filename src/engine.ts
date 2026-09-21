import { evalExpression } from "./expr.ts";
import { digestPackage, digestVersion } from "./digest.ts";
import type {
  BoundaryPosition,
  CouponAssessment,
  CouponInput,
  EvaluationResult,
  ExclusionReason,
  GroupAssessment,
  IntervalVariableRule,
  NearestCoupon,
  ProductionSpec,
  RulePackage,
  RuleVersion,
  VariableAssessment,
  VariableEvidence,
  VariableRule,
} from "./types.ts";

/** 从试件 / 生产记录中取一个变量的原始行。 */
interface RawVar {
  variable: string;
  nominal?: number | null;
  measured?: number | null;
  text?: string | null;
  unit?: string | null;
}

interface ProductionValue {
  value: number | string;
  source: ValueSource | "text";
  unit: string | null;
}

type ValueSource = "nominal" | "measured";

interface IntervalComputed {
  lower: number | null;
  upper: number | null;
  lowerBound: "open" | "closed" | null;
  upperBound: "open" | "closed" | null;
  boundary: BoundaryPosition;
  covered: boolean;
}

/** 数值落在界限上时严格按规则声明的开闭性判定。 */
export function membership(productionValue: number, couponValue: number, rule: IntervalVariableRule): IntervalComputed {
  const lower = rule.lower ? evalExpression(rule.lower.expr, couponValue) : null;
  const upper = rule.upper ? evalExpression(rule.upper.expr, couponValue) : null;
  const lowerBound = rule.lower?.bound ?? null;
  const upperBound = rule.upper?.bound ?? null;

  let aboveLower = false;
  let atLower = false;
  if (lower === null) {
    aboveLower = true;
  } else {
    if (productionValue > lower) {
      aboveLower = true;
    } else if (productionValue === lower) {
      atLower = true;
      aboveLower = lowerBound === "closed";
    }
  }

  let belowUpper = false;
  let atUpper = false;
  if (upper === null) {
    belowUpper = true;
  } else if (productionValue < upper) {
    belowUpper = true;
  } else if (productionValue === upper) {
    atUpper = true;
    belowUpper = upperBound === "closed";
  }

  let boundary: BoundaryPosition = "inside";
  if (atLower) {
    boundary = "lower-boundary";
  } else if (atUpper) {
    boundary = "upper-boundary";
  } else if (!aboveLower || !belowUpper) {
    boundary = "outside";
  }
  return { lower, upper, lowerBound, upperBound, boundary, covered: aboveLower && belowUpper };
}

function readValue(row: RawVar | undefined, source: ValueSource | "text", expectedUnit: string | null):
  | { ok: true; value: number | string; unit: string | null; usedSource: ValueSource | "text" }
  | { ok: false; reason: "MISSING" | "UNIT_UNKNOWN" | "UNIT_MISMATCH" } {
  if (!row) {
    return { ok: false, reason: "MISSING" };
  }
  if (source === "text") {
    if (typeof row.text !== "string" || row.text.length === 0) {
      return { ok: false, reason: "MISSING" };
    }
    return { ok: true, value: row.text, unit: null, usedSource: "text" };
  }
  const raw = source === "nominal" ? row.nominal : row.measured;
  if (typeof raw !== "number" || Number.isNaN(raw)) {
    return { ok: false, reason: "MISSING" };
  }
  if (expectedUnit !== null) {
    if (row.unit === null || row.unit === undefined || row.unit === "") {
      return { ok: false, reason: "UNIT_UNKNOWN" };
    }
    if (row.unit !== expectedUnit) {
      return { ok: false, reason: "UNIT_MISMATCH" };
    }
  }
  return { ok: true, value: raw, unit: row.unit ?? null, usedSource: source };
}

interface CouponEval {
  assessment: CouponAssessment;
  covers: Map<string, VariableEvidence | null>;
}

function assessCoupon(
  coupon: CouponInput & { id?: number },
  production: Map<string, ProductionValue>,
  rule: RuleVersion,
): CouponEval {
  const couponId = coupon.id ?? 0;
  const vars = new Map<string, RawVar>(coupon.variables.map((v) => [v.variable, v]));
  const policy = rule.recordPolicy;

  let excludedReason: ExclusionReason | null = null;
  let excludedDetail: string | null = null;
  if (policy.expiredStatuses.includes(coupon.status)) {
    excludedReason = "EXPIRED";
    excludedDetail = `试件 ${coupon.code} 状态为已过期`;
  } else if (policy.withdrawnStatuses.includes(coupon.status)) {
    excludedReason = "WITHDRAWN";
    excludedDetail = `试件 ${coupon.code} 状态为已撤销`;
  }

  const mechanicalPassed = rule.requiredMechanical.filter((required) =>
    coupon.mechanical.some((test) => test.testType === required && test.result === "pass"),
  );
  const mechanicalMissing = rule.requiredMechanical.filter(
    (required) => !mechanicalPassed.includes(required),
  );

  if (excludedReason === null && mechanicalMissing.length > 0) {
    excludedReason = "MECHANICAL_INCOMPLETE";
    excludedDetail = `试件 ${coupon.code} 缺力学合格项: ${mechanicalMissing.join(", ")}`;
  }

  const covers = new Map<string, VariableEvidence | null>();
  const coveredVariables: string[] = [];
  const missingVariables: string[] = [];

  for (const variableName of rule.requiredVariables) {
    const variableRule: VariableRule | undefined = rule.variables[variableName];
    if (variableRule === undefined) {
      continue;
    }
    const productionEntry = production.get(variableName);
    const raw = vars.get(variableName);
    const source: ValueSource | "text" =
      variableRule.kind === "categorical" ? "text" : variableRule.couponValue;
    const expectedUnit = variableRule.kind === "interval" ? variableRule.unit : null;
    const read = readValue(raw, source, expectedUnit);

    // 单位不明 / 单位不一致：该试件任何变量都不得作为证据，整条记录排除。
    if (!read.ok && (read.reason === "UNIT_UNKNOWN" || read.reason === "UNIT_MISMATCH")) {
      if (excludedReason === null) {
        excludedReason = read.reason === "UNIT_UNKNOWN" ? "UNIT_UNKNOWN" : ("UNIT_MISMATCH" as ExclusionReason);
        excludedDetail =
          read.reason === "UNIT_UNKNOWN"
            ? `试件 ${coupon.code} 的 ${variableName} 单位不明`
            : `试件 ${coupon.code} 的 ${variableName} 单位与规则声明 (${expectedUnit}) 不一致`;
      }
    }

    const hardExcluded =
      excludedReason === "EXPIRED" ||
      excludedReason === "WITHDRAWN" ||
      excludedReason === "UNIT_UNKNOWN" ||
      excludedReason === "UNIT_MISMATCH";

    if (hardExcluded || !read.ok || productionEntry === undefined) {
      covers.set(variableName, null);
      if (!hardExcluded) {
        missingVariables.push(variableName);
      }
      continue;
    }

    if (variableRule.kind === "categorical") {
      const matched = read.value === productionEntry.value;
      if (matched) {
        coveredVariables.push(variableName);
        covers.set(variableName, {
          couponId,
          code: coupon.code,
          couponValue: read.value,
          couponValueSource: "text",
          lower: null,
          upper: null,
          lowerBound: null,
          upperBound: null,
          boundary: "inside",
        });
      } else {
        missingVariables.push(variableName);
        covers.set(variableName, null);
      }
      continue;
    }

    const computed = membership(productionEntry.value as number, read.value as number, variableRule);
    if (computed.covered) {
      coveredVariables.push(variableName);
    } else {
      missingVariables.push(variableName);
    }
    covers.set(
      variableName,
      computed.covered
        ? {
            couponId,
            code: coupon.code,
            couponValue: read.value as number,
            couponValueSource: read.usedSource as ValueSource,
            lower: computed.lower,
            upper: computed.upper,
            lowerBound: computed.lowerBound,
            upperBound: computed.upperBound,
            boundary: computed.boundary,
          }
        : null,
    );
  }

  const usable = excludedReason === null;
  const hardExcluded =
    excludedReason === "EXPIRED" ||
    excludedReason === "WITHDRAWN" ||
    excludedReason === "UNIT_UNKNOWN" ||
    excludedReason === "UNIT_MISMATCH";
  if (hardExcluded) {
    coveredVariables.length = 0;
    missingVariables.splice(0, missingVariables.length);
    for (const variableName of rule.requiredVariables) {
      covers.set(variableName, null);
    }
  }

  return {
    assessment: {
      couponId,
      code: coupon.code,
      status: coupon.status,
      usable,
      excludedReason,
      excludedDetail,
      coveredVariables: hardExcluded ? [] : coveredVariables,
      missingVariables: hardExcluded ? [...rule.requiredVariables] : missingVariables,
      mechanicalPassed,
      mechanicalMissing,
    },
    covers,
  };
}

function extractProduction(spec: ProductionSpec, rule: RuleVersion):
  | { ok: true; values: Map<string, ProductionValue>; assessments: VariableAssessment[] }
  | { ok: false; assessments: VariableAssessment[] } {
  const values = new Map<string, ProductionValue>();
  const assessments: VariableAssessment[] = [];
  const rows = new Map<string, RawVar>(spec.variables.map((v) => [v.variable, v]));
  let allOk = true;

  for (const variableName of rule.requiredVariables) {
    const variableRule = rule.variables[variableName];
    if (variableRule === undefined) {
      continue;
    }
    const row = rows.get(variableName);
    const source: ValueSource | "text" =
      variableRule.kind === "categorical" ? "text" : variableRule.productionValue;
    const expectedUnit = variableRule.kind === "interval" ? variableRule.unit : null;
    const read = readValue(row, source, expectedUnit);

    if (!read.ok) {
      allOk = false;
      assessments.push({
        variable: variableName,
        kind: variableRule.kind,
        status: "gap",
        productionValue: null,
        productionValueSource: null,
        unit: expectedUnit,
        evidence: [],
        gapReason:
          read.reason === "MISSING"
            ? `生产工艺缺少 ${variableName} 的${source === "text" ? "标称取值" : source === "nominal" ? "标称值" : "实测值"}`
            : read.reason === "UNIT_UNKNOWN"
              ? `生产工艺 ${variableName} 单位不明`
              : `生产工艺 ${variableName} 单位与规则声明 (${expectedUnit}) 不一致`,
      });
      continue;
    }

    values.set(variableName, { value: read.value, source: read.usedSource, unit: read.unit });
    assessments.push({
      variable: variableName,
      kind: variableRule.kind,
      status: "gap",
      productionValue: read.value,
      productionValueSource: read.usedSource,
      unit: expectedUnit,
      evidence: [],
      gapReason: null,
    });
  }

  return allOk ? { ok: true, values, assessments } : { ok: false, assessments };
}

export interface EvaluateInput {
  pkg: RulePackage;
  rule: RuleVersion;
  spec: ProductionSpec;
  coupons: Array<CouponInput & { id?: number }>;
}

export function evaluate({ pkg, rule, spec, coupons }: EvaluateInput): EvaluationResult {
  const extracted = extractProduction(spec, rule);
  const variableAssessments = extracted.assessments;

  const evaluations = coupons.map((coupon) => assessCoupon(coupon, extracted.ok ? extracted.values : new Map(), rule));

  const rejectionReasons: string[] = [];
  for (const evaluation of evaluations) {
    if (evaluation.assessment.excludedDetail !== null) {
      rejectionReasons.push(evaluation.assessment.excludedDetail);
    }
  }

  // 逐变量汇总命中证据。
  for (const assessment of variableAssessments) {
    const evidence: VariableEvidence[] = [];
    for (const evaluation of evaluations) {
      if (!evaluation.assessment.usable) {
        continue;
      }
      const hit = evaluation.covers.get(assessment.variable);
      if (hit) {
        evidence.push(hit);
      }
    }
    if (evidence.length > 0) {
      assessment.status = "covered";
    } else if (assessment.gapReason === null) {
      assessment.gapReason = `没有有效试件覆盖变量 ${assessment.variable}`;
    }
    assessment.evidence = evidence;
  }

  // 联合组：组内变量必须由同一试件联合证明。
  const groups: GroupAssessment[] = rule.jointGroups.map((group) => {
    const jointHits: string[] = [];
    for (const evaluation of evaluations) {
      if (!evaluation.assessment.usable) {
        continue;
      }
      const allCovered = group.variables.every((variableName) => {
        const hit = evaluation.covers.get(variableName);
        return hit !== null && hit !== undefined;
      });
      if (allCovered) {
        jointHits.push(evaluation.assessment.code);
      }
    }
    return {
      id: group.id,
      label: group.label,
      variables: group.variables,
      satisfied: jointHits.length > 0,
      satisfiedBy: jointHits.length > 0 ? jointHits : null,
    };
  });

  let conclusion: EvaluationResult["conclusion"] = "NOT_COVERED";

  if (!extracted.ok) {
    conclusion = "NOT_COVERED";
  } else {
    const groupedVariables = new Set(rule.jointGroups.flatMap((group) => group.variables));
    const standaloneCovered = rule.requiredVariables
      .filter((name) => !groupedVariables.has(name))
      .every((name) => variableAssessments.find((a) => a.variable === name)?.status === "covered");
    const groupsSatisfied = groups.every((group) => group.satisfied);

    const singleCouponCoversAllGroups = evaluations.some(
      (evaluation) =>
        evaluation.assessment.usable &&
        rule.jointGroups.every((group) =>
          group.variables.every((name) => {
            const hit = evaluation.covers.get(name);
            return hit !== null && hit !== undefined;
          }),
        ),
    );

    if (standaloneCovered && groupsSatisfied) {
      if (rule.stitching === "forbidden") {
        conclusion = singleCouponCoversAllGroups ? "COVERED" : "NOT_COVERED";
        if (!singleCouponCoversAllGroups) {
          rejectionReasons.push(
            `规则 ${rule.version} 禁止跨试件拼接（stitching=forbidden）：单项证据虽来自合格试件，但不存在同一试件联合满足全部变量组，虚假拼接不构成覆盖`,
          );
        }
      } else {
        conclusion = "COVERED";
      }
    } else if (rule.stitching === "forbidden" && !singleCouponCoversAllGroups) {
      rejectionReasons.push(
        `规则 ${rule.version} 禁止跨试件拼接（stitching=forbidden）：必须由同一试件联合证明全部变量，当前无单一试件满足`,
      );
    }
  }

  if (conclusion === "NOT_COVERED" && extracted.ok) {
    for (const group of groups) {
      if (!group.satisfied) {
        rejectionReasons.push(
          `联合组「${group.label}」无单一试件同时证明: ${group.variables.join("、")}`,
        );
      }
    }
    for (const assessment of variableAssessments) {
      if (assessment.status === "gap" && assessment.gapReason !== null) {
        rejectionReasons.push(assessment.gapReason);
      }
    }
  }

  const nearest = buildNearest(evaluations.map((evaluation) => evaluation.assessment), rule);

  return {
    packageId: rule.packageId,
    version: rule.version,
    packageDigest: digestPackage(pkg),
    versionDigest: digestVersion(rule),
    stitching: rule.stitching,
    requiredMechanical: rule.requiredMechanical,
    conclusion,
    variables: variableAssessments,
    groups,
    couponAssessments: evaluations.map((evaluation) => evaluation.assessment),
    nearest,
    rejectionReasons: Array.from(new Set(rejectionReasons)),
    evaluatedAt: new Date().toISOString(),
  };
}

/**
 * 离合格最近的试验：在“状态有效、单位可判定”的试件中，
 * 按已覆盖变量数排序（含力学不完整但工艺命中的试件），
 * 并明确指出仍缺哪条证据。过期/撤销/单位不明者不参与。
 */
function buildNearest(assessments: CouponAssessment[], rule: RuleVersion): NearestCoupon | null {
  const candidates = assessments.filter(
    (assessment) =>
      assessment.excludedReason === null ||
      assessment.excludedReason === "MECHANICAL_INCOMPLETE",
  );
  if (candidates.length === 0) {
    return null;
  }
  const ranked = [...candidates].sort((a, b) => {
    if (b.coveredVariables.length !== a.coveredVariables.length) {
      return b.coveredVariables.length - a.coveredVariables.length;
    }
    return a.couponId - b.couponId;
  });
  const best = ranked[0];
  if (best === undefined) {
    return null;
  }

  const missingEvidence: string[] = [];
  for (const group of rule.jointGroups) {
    const missingInGroup = group.variables.filter((name) => best.missingVariables.includes(name));
    if (missingInGroup.length > 0) {
      missingEvidence.push(`联合组「${group.label}」内仍缺: ${missingInGroup.join("、")}`);
    }
  }
  const grouped = new Set(rule.jointGroups.flatMap((group) => group.variables));
  const standaloneMissing = best.missingVariables.filter((name) => !grouped.has(name));
  if (standaloneMissing.length > 0) {
    missingEvidence.push(`仍缺变量证据: ${standaloneMissing.join("、")}`);
  }

  let note: string;
  if (best.excludedReason === "MECHANICAL_INCOMPLETE") {
    note = `该试件工艺变量全部命中，但力学检验不合格/未完成，补齐 ${best.mechanicalMissing.join("、")} 合格记录后可成证据`;
  } else if (rule.stitching === "forbidden") {
    note = "该版本禁止跨试件拼接；下列证据必须在同一试件上补齐（或以单一新试件联合证明）";
  } else {
    note = "该版本允许按联合组拼接；下列缺口可由另一试件在同组内补齐";
  }

  return {
    couponId: best.couponId,
    code: best.code,
    coveredCount: best.coveredVariables.length,
    coveredVariables: best.coveredVariables,
    missingEvidence,
    mechanicalMissing: best.mechanicalMissing,
    note,
  };
}

export interface VersionRangeChange {
  variable: string;
  kind: "interval" | "categorical";
  from: { lowerExpr: string | null; upperExpr: string | null; lowerBound: string | null; upperBound: string | null } | null;
  to: { lowerExpr: string | null; upperExpr: string | null; lowerBound: string | null; upperBound: string | null } | null;
  sample: { couponValue: number; fromRange: [number | null, number | null]; toRange: [number | null, number | null] };
  change: "narrowed" | "widened" | "moved" | "unchanged" | "added" | "removed";
}

/** 比较两个规则版本对每个变量造成的覆盖范围变化（以一个试件值 v 作样例）。 */
export function compareVersions(from: RuleVersion, to: RuleVersion, sampleValues: Record<string, number>): VersionRangeChange[] {
  const names = Array.from(new Set([...from.requiredVariables, ...to.requiredVariables]));
  const changes: VersionRangeChange[] = [];
  for (const name of names) {
    const a = from.variables[name];
    const b = to.variables[name];
    if (a?.kind === "interval" || b?.kind === "interval") {
      const sample = sampleValues[name] ?? 10;
      const rangeOf = (rule: typeof a): [number | null, number | null] => {
        if (rule?.kind !== "interval") {
          return [null, null];
        }
        return [
          rule.lower ? evalExpression(rule.lower.expr, sample) : null,
          rule.upper ? evalExpression(rule.upper.expr, sample) : null,
        ];
      };
      const [aLo, aHi] = rangeOf(a);
      const [bLo, bHi] = rangeOf(b);
      let change: VersionRangeChange["change"] = "unchanged";
      if (a?.kind !== "interval") {
        change = "added";
      } else if (b?.kind !== "interval") {
        change = "removed";
      } else if (
        a.lower?.expr === b.lower?.expr &&
        a.upper?.expr === b.upper?.expr &&
        a.lower?.bound === b.lower?.bound &&
        a.upper?.bound === b.upper?.bound
      ) {
        change = "unchanged";
      } else {
        const aWidth = aLo !== null && aHi !== null ? aHi - aLo : null;
        const bWidth = bLo !== null && bHi !== null ? bHi - bLo : null;
        if (aWidth !== null && bWidth !== null) {
          change = bWidth < aWidth ? "narrowed" : bWidth > aWidth ? "widened" : "moved";
        } else {
          change = "moved";
        }
      }
      changes.push({
        variable: name,
        kind: "interval",
        from:
          a?.kind === "interval"
            ? { lowerExpr: a.lower?.expr ?? null, upperExpr: a.upper?.expr ?? null, lowerBound: a.lower?.bound ?? null, upperBound: a.upper?.bound ?? null }
            : null,
        to:
          b?.kind === "interval"
            ? { lowerExpr: b.lower?.expr ?? null, upperExpr: b.upper?.expr ?? null, lowerBound: b.lower?.bound ?? null, upperBound: b.upper?.bound ?? null }
            : null,
        sample: { couponValue: sample, fromRange: [aLo, aHi], toRange: [bLo, bHi] },
        change,
      });
    } else {
      changes.push({
        variable: name,
        kind: "categorical",
        from: null,
        to: null,
        sample: { couponValue: 0, fromRange: [null, null], toRange: [null, null] },
        change: JSON.stringify(a ?? null) === JSON.stringify(b ?? null) ? "unchanged" : "moved",
      });
    }
  }
  return changes;
}
