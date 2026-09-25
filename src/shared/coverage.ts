import type {
  CoverageResult,
  Evidence,
  ExcludedRecord,
  GroupVerdict,
  Interval,
  NearestTrial,
  ProductionProcess,
  QualificationRecord,
  RulePackage,
  TestPiece,
  VariableRule,
  VariableVerdict,
} from "./types.js";
import { containment, formatInterval, qualifiedInterval, round, ruleDigest } from "./rules.js";

interface PieceVarEval {
  covered: boolean;
  distance: number;
  interval?: Interval;
  missing?: string;
  excludedReason?: string;
}

function asArray(v: number | string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [String(v)];
}

/** 评估单个试件对单个变量是否覆盖生产值。 */
function evalPieceVar(
  variable: VariableRule,
  piece: TestPiece,
  prodValue: number | string | string[],
): PieceVarEval {
  const pv = piece.values[variable.key];
  if (!pv) return { covered: false, distance: Number.POSITIVE_INFINITY, missing: "试件未记录该变量" };

  if (variable.kind === "number") {
    if (typeof prodValue !== "number") return { covered: false, distance: Infinity, missing: "生产值不是数值" };
    if (!pv.unit) return { covered: false, distance: Infinity, excludedReason: `变量 ${variable.label} 单位不明` };
    if (variable.unit && pv.unit !== variable.unit) {
      return { covered: false, distance: Infinity, excludedReason: `变量 ${variable.label} 单位 ${pv.unit} 与规则单位 ${variable.unit} 不符` };
    }
    if (typeof pv.measured !== "number") {
      return { covered: false, distance: Infinity, excludedReason: `变量 ${variable.label} 缺少实测值` };
    }
    const nominal = typeof pv.nominal === "number" ? pv.nominal : undefined;
    const interval = qualifiedInterval(variable, pv.measured, nominal);
    const c = containment(interval, prodValue);
    return {
      covered: c.inside,
      distance: c.distance,
      interval,
      missing: c.inside
        ? undefined
        : c.onExcludedBoundary
          ? `生产值 ${prodValue} 恰好在${c.onExcludedBoundary ? "开区间" : ""}界限上，规则声明为开区间，判定不覆盖`
          : `生产值 ${prodValue} 超出合格区间 ${formatInterval(interval, variable.unit)}（差 ${round(c.distance)} ${variable.unit ?? ""}）`,
    };
  }

  const actual = pv.measured ?? pv.nominal;
  if (variable.kind === "enum") {
    const ok = String(actual) === String(prodValue);
    return {
      covered: ok,
      distance: ok ? 0 : 1,
      missing: ok ? undefined : `资格值 ${String(actual)} 与生产值 ${String(prodValue)} 不一致`,
    };
  }

  // enum-set：生产需求集合须为试件合格集合的子集
  const have = new Set(asArray(actual));
  const need = asArray(prodValue);
  const lacking = need.filter((x) => !have.has(x));
  return {
    covered: lacking.length === 0,
    distance: lacking.length,
    missing: lacking.length ? `缺少: ${lacking.join("、")}` : undefined,
  };
}

function evidenceOf(recordId: string, pieceId: string, variable: VariableRule, ev: PieceVarEval): Evidence {
  return {
    recordId,
    pieceId,
    detail: ev.interval
      ? `合格区间 ${formatInterval(ev.interval, variable.unit)}`
      : "匹配生产要求",
    interval: ev.interval,
  };
}

export function checkCoverage(
  rule: RulePackage,
  records: QualificationRecord[],
  production: ProductionProcess,
  asOf: string,
): CoverageResult {
  const excluded: ExcludedRecord[] = [];
  const usable: QualificationRecord[] = [];

  for (const rec of records) {
    const reasons: string[] = [];
    if (rec.status === "revoked") reasons.push("记录已撤销");
    if (rec.status === "expired") reasons.push("记录已过期");
    if (rec.validUntil && rec.validUntil < asOf) reasons.push(`有效期至 ${rec.validUntil}，截至 ${asOf} 已过期`);
    if (reasons.length) excluded.push({ recordId: rec.id, reasons });
    else usable.push(rec);
  }

  const groupOf = new Map<string, string>();
  for (const g of rule.jointGroups) for (const v of g.variables) groupOf.set(v, g.key);

  const varByKey = new Map(rule.variables.map((v) => [v.key, v]));
  const groupVerdicts: GroupVerdict[] = [];
  const groupEvidence = new Map<string, Evidence[]>();
  const groupGap = new Map<string, { reason: string; missingDesc: string; best: { recordId: string; pieceId: string; evals: PieceVarEval[] } | null }>();

  const noteExcluded = (recordId: string, note: string) => {
    const entry = excluded.find((e) => e.recordId === recordId);
    if (entry) { if (!entry.reasons.includes(note)) entry.reasons.push(note); }
    else excluded.push({ recordId, reasons: [note] });
  };

  // 联合证明组：所有成员变量必须由同一试件覆盖
  for (const group of rule.jointGroups) {
    const vars = group.variables.map((k) => varByKey.get(k)!);
    interface Cand { recordId: string; pieceId: string; evals: PieceVarEval[]; coveredCount: number; totalDistance: number }
    const cands: Cand[] = [];
    for (const rec of usable) {
      for (const piece of rec.pieces) {
        const evals = vars.map((v, i) => {
          const prodVal = production.values[v.key];
          if (prodVal === undefined) return { covered: false, distance: Infinity, missing: "生产工艺未给出该变量" };
          const ev = evalPieceVar(v, piece, prodVal);
          if (ev.excludedReason) noteExcluded(rec.id, `试件 ${piece.id}：${ev.excludedReason}，未参与 ${v.label} 判定`);
          return ev;
        });
        const coveredCount = evals.filter((e) => e.covered).length;
        const totalDistance = evals.reduce((s, e) => s + (Number.isFinite(e.distance) ? e.distance : 0), 0);
        cands.push({ recordId: rec.id, pieceId: piece.id, evals, coveredCount, totalDistance });
      }
    }
    const ok = cands.find((c) => c.coveredCount === vars.length);
    if (ok) {
      groupVerdicts.push({ key: group.key, label: group.label, satisfied: true, recordId: ok.recordId, pieceId: ok.pieceId, missing: [] });
      groupEvidence.set(
        group.key,
        vars.map((v, i) => evidenceOf(ok.recordId, ok.pieceId, v, ok.evals[i]!)),
      );
    } else {
      const viable = cands.filter((c) => c.evals.every((e) => !e.excludedReason));
      viable.sort((a, b) => b.coveredCount - a.coveredCount || a.totalDistance - b.totalDistance);
      const best = viable[0] ?? null;
      const missingDesc = best
        ? vars.filter((_, i) => !best.evals[i]!.covered).map((v, i2) => {
            const idx = vars.indexOf(v);
            return `${v.label}（${best.evals[idx]!.missing ?? "未覆盖"}）`;
          })
        : vars.map((v) => v.label);
      groupVerdicts.push({ key: group.key, label: group.label, satisfied: false, missing: missingDesc });
      groupGap.set(group.key, {
        reason: `联合证明组「${group.label}」要求 ${vars.map((v) => v.label).join("、")} 由同一试件证明，规则不允许跨试件拼接（试件已覆盖 ${best?.coveredCount ?? 0}/${vars.length} 个变量，仍缺：${missingDesc.join("；")}）`,
        missingDesc: missingDesc.join("；"),
        best: best ? { recordId: best.recordId, pieceId: best.pieceId, evals: best.evals } : null,
      });
    }
  }

  // 单变量判定（非联合组成员）
  const verdicts: VariableVerdict[] = [];
  for (const variable of rule.variables) {
    if (!variable.required) continue;
    const prodVal = production.values[variable.key];
    const groupKey = groupOf.get(variable.key);

    if (groupKey) {
      const evs = groupEvidence.get(groupKey);
      if (evs) {
        const mine = evs[rule.jointGroups.find((g) => g.key === groupKey)!.variables.indexOf(variable.key)]!;
        verdicts.push({ key: variable.key, label: variable.label, covered: true, viaGroup: groupKey, evidence: [mine] });
      } else {
        const g = groupGap.get(groupKey)!;
        const group = rule.jointGroups.find((x) => x.key === groupKey)!;
        const idx = group.variables.indexOf(variable.key);
        const myEval = g.best?.evals[idx];
        const gap: VariableVerdict["gap"] = {
          reason: g.reason,
          nearest: g.best && myEval
            ? {
                recordId: g.best.recordId,
                pieceId: g.best.pieceId,
                distance: round(Number.isFinite(myEval.distance) ? myEval.distance : 0),
                missing: myEval.missing ?? g.missingDesc,
                interval: myEval.interval,
              }
            : null,
        };
        verdicts.push({ key: variable.key, label: variable.label, covered: false, viaGroup: groupKey, evidence: [], gap });
      }
      continue;
    }

    if (prodVal === undefined) {
      verdicts.push({
        key: variable.key, label: variable.label, covered: false, evidence: [],
        gap: { reason: "生产工艺未给出该必要变量", nearest: null },
      });
      continue;
    }

    const spliceAllowed = rule.splice.allowedVariables.includes(variable.key);
    const perPiece: { rec: QualificationRecord; piece: TestPiece; ev: PieceVarEval }[] = [];
    for (const rec of usable) {
      for (const piece of rec.pieces) {
        const ev = evalPieceVar(variable, piece, prodVal);
        if (ev.excludedReason) {
          noteExcluded(rec.id, `试件 ${piece.id}：${ev.excludedReason}，未参与 ${variable.label} 判定`);
        }
        perPiece.push({ rec, piece, ev });
      }
    }

    const hits = perPiece.filter((p) => p.ev.covered);
    if (hits.length) {
      verdicts.push({
        key: variable.key, label: variable.label, covered: true,
        evidence: hits.map((h) => evidenceOf(h.rec.id, h.piece.id, variable, h.ev)),
      });
      continue;
    }

    // 明确允许拼接的集合型变量：跨试件取并集
    if (spliceAllowed && variable.kind === "enum-set") {
      const need = asArray(prodVal);
      const remaining = new Set(need);
      const contrib: Evidence[] = [];
      for (const p of perPiece) {
        if (p.ev.excludedReason) continue;
        const have = asArray(p.piece.values[variable.key]?.measured ?? p.piece.values[variable.key]?.nominal);
        const add = have.filter((x) => remaining.has(x));
        if (add.length) {
          contrib.push({ recordId: p.rec.id, pieceId: p.piece.id, detail: `拼接贡献: ${add.join("、")}` });
          for (const a of add) remaining.delete(a);
        }
      }
      if (remaining.size === 0 && contrib.length) {
        verdicts.push({ key: variable.key, label: variable.label, covered: true, evidence: contrib });
        continue;
      }
    }

    const viable = perPiece.filter((p) => !p.ev.excludedReason && Number.isFinite(p.ev.distance));
    viable.sort((a, b) => a.ev.distance - b.ev.distance);
    const best = viable[0];
    verdicts.push({
      key: variable.key, label: variable.label, covered: false, evidence: [],
      gap: {
        reason: spliceAllowed ? "无任何试件覆盖，且拼接后仍有缺口" : "无任何单一试件覆盖该变量，规则未允许跨试件拼接",
        nearest: best
          ? {
              recordId: best.rec.id,
              pieceId: best.piece.id,
              distance: round(best.ev.distance),
              missing: best.ev.missing ?? "未覆盖",
              interval: best.ev.interval,
            }
          : null,
      },
    });
  }

  const conclusion = verdicts.every((v) => v.covered) ? "covered" : "not-covered";
  return {
    ruleVersion: rule.version,
    ruleDigest: ruleDigest(rule),
    asOf,
    conclusion,
    variables: verdicts,
    groups: groupVerdicts,
    excludedRecords: excluded,
  };
}
