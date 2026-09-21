/**
 * 焊程见证台 —— 领域类型定义
 *
 * 口径约定：
 * - 区间变量（厚度 / 热输入 / 直径）同时分开存储标称值 nominal 与实测值 measured；
 *   规则声明评估时取哪一个，二者不互相替代。
 * - 标称值与实测值单位分开记录；单位不明或与规则声明不一致的数值不得作为证据。
 * - 分类变量（母材组 / 填充材料 / 位置）以字符串精确匹配。
 */

export type BoundKind = "open" | "closed";

/** 受限条件表达式：只允许数字、变量 v 与 + - * / ( ) 一元负号，不执行任意代码。 */
export interface ArithmeticExpr {
  expr: string;
}

export interface IntervalBound {
  /** 以试件变量值 v 为输入的算术表达式，例如 0.5 * v 或 2 * v。 */
  expr: string;
  /** closed = 含界（[ 或 ]），open = 不含界（( 或 )）。 */
  bound: BoundKind;
}

export type ValueSource = "nominal" | "measured";

export interface IntervalVariableRule {
  kind: "interval";
  /** 规则要求的计量单位；生产值与试件值都必须显式声明相同单位。 */
  unit: string;
  /** 评估生产工艺时读取标称值还是实测值。 */
  productionValue: ValueSource;
  /** 读取试件记录时读取标称值还是实测值。 */
  couponValue: ValueSource;
  /** 下界；null 表示负无穷。 */
  lower: IntervalBound | null;
  /** 上界；null 表示正无穷。 */
  upper: IntervalBound | null;
}

export interface CategoricalVariableRule {
  kind: "categorical";
  /** 合法取值域；生产值与试件值都必须落在此集合内。 */
  values: string[];
  match: "exact";
}

export type VariableRule = IntervalVariableRule | CategoricalVariableRule;

export interface JointGroup {
  id: string;
  label: string;
  /** 组内变量必须由同一试件联合证明。 */
  variables: string[];
}

export type StitchMode = "forbidden" | "permitted";

export interface RecordPolicy {
  validStatuses: string[];
  expiredStatuses: string[];
  withdrawnStatuses: string[];
  /** 数值证据是否必须携带与规则一致的单位。 */
  requireKnownUnit: boolean;
}

export interface RuleVersion {
  packageId: string;
  version: string;
  label: string;
  publishedAt: string;
  requiredVariables: string[];
  variables: Record<string, VariableRule>;
  /** 试件必须具备的力学检验合格项。 */
  requiredMechanical: string[];
  jointGroups: JointGroup[];
  stitching: StitchMode;
  recordPolicy: RecordPolicy;
  changelog: string[];
}

export interface RulePackage {
  packageId: string;
  formatVersion: number;
  description: string;
  unitRegistry: Record<string, { unit: string; display: string }>;
  versions: RuleVersion[];
}

export type CouponStatus = "valid" | "expired" | "withdrawn";

export interface CouponVariableInput {
  variable: string;
  nominal?: number | null;
  measured?: number | null;
  text?: string | null;
  unit?: string | null;
}

export interface MechanicalTestInput {
  testType: string;
  result: "pass" | "fail";
  value?: number | null;
  unit?: string | null;
  testedAt?: string | null;
}

export interface CouponInput {
  code: string;
  status: CouponStatus;
  validFrom?: string | null;
  validUntil?: string | null;
  note?: string | null;
  variables: CouponVariableInput[];
  mechanical: MechanicalTestInput[];
}

export interface ProductionVariableInput {
  variable: string;
  nominal?: number | null;
  measured?: number | null;
  text?: string | null;
  unit?: string | null;
}

export interface ProductionSpec {
  name: string;
  variables: ProductionVariableInput[];
}

export type ExclusionReason =
  | "EXPIRED"
  | "WITHDRAWN"
  | "UNIT_UNKNOWN"
  | "UNIT_MISMATCH"
  | "MECHANICAL_INCOMPLETE";

export interface CouponAssessment {
  couponId: number;
  code: string;
  status: CouponStatus;
  usable: boolean;
  excludedReason: ExclusionReason | null;
  excludedDetail: string | null;
  coveredVariables: string[];
  missingVariables: string[];
  mechanicalPassed: string[];
  mechanicalMissing: string[];
}

export type BoundaryPosition = "inside" | "outside" | "lower-boundary" | "upper-boundary";

export interface VariableEvidence {
  couponId: number;
  code: string;
  couponValue: number | string;
  couponValueSource: ValueSource | "text";
  lower: number | null;
  upper: number | null;
  lowerBound: BoundKind | null;
  upperBound: BoundKind | null;
  boundary: BoundaryPosition;
}

export interface GroupAssessment {
  id: string;
  label: string;
  variables: string[];
  satisfied: boolean;
  satisfiedBy: string[] | null;
}

export interface VariableAssessment {
  variable: string;
  kind: "interval" | "categorical";
  status: "covered" | "gap";
  productionValue: number | string | null;
  productionValueSource: ValueSource | "text" | null;
  unit: string | null;
  evidence: VariableEvidence[];
  gapReason: string | null;
}

export interface NearestCoupon {
  couponId: number;
  code: string;
  coveredCount: number;
  coveredVariables: string[];
  missingEvidence: string[];
  mechanicalMissing: string[];
  note: string;
}

export type Conclusion = "COVERED" | "NOT_COVERED";

export interface EvaluationResult {
  packageId: string;
  version: string;
  packageDigest: string;
  versionDigest: string;
  stitching: StitchMode;
  requiredMechanical: string[];
  conclusion: Conclusion;
  variables: VariableAssessment[];
  groups: GroupAssessment[];
  couponAssessments: CouponAssessment[];
  nearest: NearestCoupon | null;
  rejectionReasons: string[];
  evaluatedAt: string;
}

export interface RunRecord {
  id: number;
  packageId: string;
  version: string;
  digest: string;
  specName: string | null;
  specJson: string;
  resultJson: string;
  conclusion: Conclusion;
  createdAt: string;
}
