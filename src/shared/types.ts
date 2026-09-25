/** 规则包与资格记录的共享类型定义。 */

export type BoundKind = "closed" | "open";

export interface IntervalCase {
  /** 受限条件表达式，如 "t <= 38"；缺省表示恒真。 */
  when?: string;
  /** 下界表达式（受限表达式），null 表示无下界。 */
  lower: string | null;
  /** 上界表达式（受限表达式），null 表示无上界。 */
  upper: string | null;
  lowerBound: BoundKind;
  upperBound: BoundKind;
}

export interface VariableRule {
  key: string;
  label: string;
  kind: "enum" | "enum-set" | "number";
  unit?: string;
  /** 数值变量在表达式中的别名，如厚度 t、热输入 h。 */
  measuredVar?: string;
  required: boolean;
  /** enum 的匹配方式：exact 表示生产值必须等于资格值。 */
  match?: "exact";
  extension?: { cases: IntervalCase[] };
}

export interface JointGroup {
  key: string;
  label: string;
  /** 这些变量必须由同一试件联合证明。 */
  variables: string[];
}

export interface RulePackage {
  id: string;
  version: string;
  issuedAt: string;
  variables: VariableRule[];
  jointGroups: JointGroup[];
  splice: {
    /** 明确允许跨试件拼接证据的变量。 */
    allowedVariables: string[];
    note?: string;
  };
}

export type RecordStatus = "valid" | "expired" | "revoked";

export interface PieceValue {
  nominal: number | string | string[];
  measured?: number | string | string[];
  unit?: string;
}

export interface TestPiece {
  id: string;
  values: Record<string, PieceValue>;
}

export interface QualificationRecord {
  id: string;
  title: string;
  status: RecordStatus;
  qualificationDate: string;
  validUntil?: string;
  pieces: TestPiece[];
}

export interface ProductionProcess {
  name: string;
  values: Record<string, number | string | string[]>;
}

export interface Interval {
  lower: number | null;
  upper: number | null;
  lowerBound: BoundKind;
  upperBound: BoundKind;
}

export interface Evidence {
  recordId: string;
  pieceId: string;
  detail: string;
  interval?: Interval;
}

export interface NearestTrial {
  recordId: string;
  pieceId: string;
  /** 距覆盖的归一化距离；0 表示仅因开区间边界或联合组缺失而未覆盖。 */
  distance: number;
  missing: string;
  interval?: Interval;
}

export interface VariableVerdict {
  key: string;
  label: string;
  covered: boolean;
  viaGroup?: string;
  evidence: Evidence[];
  gap?: { reason: string; nearest: NearestTrial | null };
}

export interface GroupVerdict {
  key: string;
  label: string;
  satisfied: boolean;
  pieceId?: string;
  recordId?: string;
  missing: string[];
}

export interface ExcludedRecord {
  recordId: string;
  reasons: string[];
}

export interface CoverageResult {
  ruleVersion: string;
  ruleDigest: string;
  asOf: string;
  conclusion: "covered" | "not-covered";
  variables: VariableVerdict[];
  groups: GroupVerdict[];
  excludedRecords: ExcludedRecord[];
}
